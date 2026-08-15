// 生成插件图标（纯 Node 实现 PNG 编码，无需第三方依赖）
// 图标：橙黄色圆角方块 + 三行白色“文字”横条

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: None
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function buildIconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size * 0.22));

  // 橙黄底 + 圆角透明
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = true;
      const cornerX = x < radius ? radius : x >= size - radius ? size - 1 - radius : x;
      const cornerY = y < radius ? radius : y >= size - radius ? size - 1 - radius : y;
      const dx = x - cornerX;
      const dy = y - cornerY;
      const inCorner = (x < radius || x >= size - radius) && (y < radius || y >= size - radius);
      if (inCorner && dx * dx + dy * dy > radius * radius) {
        inside = false;
      }
      const index = (y * size + x) * 4;
      if (inside) {
        pixels[index] = 255;     // R
        pixels[index + 1] = 165; // G -> #FFA500
        pixels[index + 2] = 0;   // B
        pixels[index + 3] = 255; // A
      }
    }
  }

  // 三行白色横条，形似文字
  const bars = [
    { y0: 0.38, width: 0.5 },
    { y0: 0.55, width: 0.66 },
    { y0: 0.72, width: 0.42 }
  ];
  const barHeight = Math.max(1, Math.round(size * 0.055));
  const barX = Math.round(size * 0.17);

  for (const bar of bars) {
    const barY = Math.round(size * bar.y0);
    const barWidth = Math.max(2, Math.round(size * bar.width));
    for (let dy = 0; dy < barHeight; dy += 1) {
      for (let dx = 0; dx < barWidth; dx += 1) {
        const x = barX + dx;
        const y = barY + dy;
        if (x >= size || y >= size) continue;
        const index = (y * size + x) * 4;
        if (pixels[index + 3] === 0) continue;
        pixels[index] = 255;
        pixels[index + 1] = 255;
        pixels[index + 2] = 255;
        pixels[index + 3] = 255;
      }
    }
  }

  return pixels;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = encodePng(size, size, buildIconPixels(size));
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`generated ${file} (${png.length} bytes)`);
}
