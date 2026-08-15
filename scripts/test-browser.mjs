// 真实浏览器端到端测试（默认使用内置 mock 模型；设置 LMSTUDIO_BASE_URL 后改用真实 LM Studio）
//   mock 模式：node scripts/test-browser.mjs
//   真实模式：LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1 [LMSTUDIO_MODEL=xxx] node scripts/test-browser.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { listOpenAIModels } from '../shared/api.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// 新版正式版 Chrome 已禁用 --load-extension，优先使用仍支持该开关的 Edge（Chromium 内核）
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER_PATH = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
const BROWSER_NAME = BROWSER_PATH === EDGE_PATH ? 'Edge' : 'Chrome';
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');

// ---------- mock OpenAI 服务 + 测试页面 ----------
let chatRequests = 0;
const WORD_TABLE_EN2ZH = {
  hello: '你好',
  world: '世界',
  'machine learning': '机器学习'
};
const WORD_TABLE_ZH2EN = {
  你好: 'hello',
  世界: 'world',
  机器学习: 'machine learning'
};

const mockServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/page') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>#text{font-size:16px;}</style></head>
      <body><p id="text">Hello world, this is a test.</p></body></html>`);
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-en-zh-model' }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    chatRequests += 1;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const messages = payload.messages || [];
      const system = messages.find((message) => message.role === 'system')?.content || '';
      const zhToEn = system.includes('中译英');
      const text = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n')
        .trim()
        .toLowerCase();
      const table = zhToEn ? WORD_TABLE_ZH2EN : WORD_TABLE_EN2ZH;
      res.end(JSON.stringify({
        choices: [{ message: { content: table[text] || `【模拟译文】${text}` } }]
      }));
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

await new Promise((resolve, reject) => {
  mockServer.once('error', reject);
  mockServer.listen(0, '127.0.0.1', resolve);
});
const mockPort = mockServer.address().port;
const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;
const pageUrl = `http://127.0.0.1:${mockPort}/page`;

// 真实 LM Studio 模式：设置了 LMSTUDIO_BASE_URL 时，翻译走真实本地模型，页面仍由本地 mock 服务提供
const LIVE_MODE = Boolean(process.env.LMSTUDIO_BASE_URL);
const liveBaseUrl = process.env.LMSTUDIO_BASE_URL || '';
const liveApiKey = process.env.LMSTUDIO_API_KEY || '';
let liveModel = process.env.LMSTUDIO_MODEL || '';

if (LIVE_MODE) {
  const models = await listOpenAIModels({ baseUrl: liveBaseUrl, apiKey: liveApiKey });
  assert.ok(models.length > 0, 'LM Studio 未返回可用模型');
  liveModel = liveModel || models[0];
  console.log(`真实模型模式：${liveBaseUrl} · ${liveModel}`);
}

const activeBaseUrl = LIVE_MODE ? liveBaseUrl : mockBaseUrl;
const activeApiKey = LIVE_MODE ? liveApiKey : '';
const activeModel = LIVE_MODE ? liveModel : 'mock-en-zh-model';
const expectedTranslation = LIVE_MODE ? null : '世界';

// ---------- 工具函数 ----------
async function waitFor(fn, timeoutMs = 20000, intervalMs = 200, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待超时：${label}${lastError ? `（最后错误：${lastError.message}）` : ''}`);
}

class CDPClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception?.description || details.exception?.value || details.text || 'unknown';
    throw new Error(`页面执行失败：${description}`);
  }
  return result.result?.value;
}

function selectWord(word) {
  return `(() => {
    const textNode = document.querySelector('#text').firstChild;
    const index = textNode.textContent.indexOf(${JSON.stringify(word)});
    const range = document.createRange();
    range.setStart(textNode, index);
    range.setEnd(textNode, index + ${word.length});
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    return selection.toString();
  })()`;
}

const readStyles = `(() => {
  const original = document.querySelector('.et-original');
  const translation = document.querySelector('.et-translation');
  const paragraph = document.querySelector('#text');
  if (!original || !translation) return null;
  const style = (element) => getComputedStyle(element);
  return {
    originalText: original.textContent,
    translationText: translation.textContent,
    belowOriginal: original.nextElementSibling === translation,
    originalColor: style(original).color,
    originalWeight: style(original).fontWeight,
    originalSize: parseFloat(style(original).fontSize),
    baseSize: parseFloat(style(paragraph).fontSize),
    translationColor: style(translation).color,
    translationWeight: style(translation).fontWeight,
    translationSize: parseFloat(style(translation).fontSize),
    translationDecoration: style(translation).textDecorationLine,
    translationBackground: style(translation).backgroundColor,
    originalBackground: style(original).backgroundColor
  };
})()`;

const readTranslationText = `(() => {
  const element = document.querySelector('.et-translation');
  return element ? element.textContent.replace('×', '').trim() : null;
})()`;

function isReadyTranslation(text) {
  return Boolean(
    text &&
    !text.includes('翻译中') &&
    !text.includes('无法翻译') &&
    !text.includes('翻译失败')
  );
}

// ---------- 启动无头浏览器并加载插件 ----------
assert.ok(fs.existsSync(BROWSER_PATH), `未找到 ${BROWSER_NAME}，跳过浏览器测试`);
console.log(`使用 ${BROWSER_NAME} 进行浏览器端到端测试`);
fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const browserProcess = spawn(BROWSER_PATH, [
  '--headless=new',
  '--enable-extensions',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE_DIR}`,
  '--remote-debugging-port=0',
  `--disable-extensions-except=${ROOT}`,
  `--load-extension=${ROOT}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

let browserCdp = null;
let pageCdp = null;
let swCdp = null;
let passed = 0;
let firstTranslationText = '';
let zhToEnTranslationText = '';

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  const debugPort = await waitFor(async () => {
    const file = path.join(PROFILE_DIR, 'DevToolsActivePort');
    if (!fs.existsSync(file)) return null;
    const firstLine = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
    return Number(firstLine);
  }, 30000, 300, 'DevToolsActivePort');

  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return response.ok ? response.json() : null;
  }, 15000, 300, 'browser version endpoint');

  browserCdp = new CDPClient(version.webSocketDebuggerUrl);
  await browserCdp.open();

  // 找到初始页面并导航到测试页
  const pageTarget = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    return targets.find((target) => target.type === 'page');
  }, 15000, 300, 'page target');

  pageCdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await pageCdp.open();
  await pageCdp.send('Page.navigate', { url: pageUrl });
  await waitFor(async () =>
    (await evaluate(pageCdp, 'document.readyState')) === 'complete',
    15000, 200, '测试页加载完成');

  // 先让内容脚本触发一次消息，把 service worker 唤醒
  console.log('浏览器端到端测试');
  await evaluate(pageCdp, selectWord('world'));
  // 通过 manifest.name 精确找到本扩展的 service worker（避免与其他扩展同名 worker 混淆）
  const swTarget = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    const candidates = targets.filter((target) => target.type === 'service_worker');
    for (const target of candidates) {
      let name = '';
      try {
        const probe = new CDPClient(target.webSocketDebuggerUrl);
        await probe.open();
        const result = await probe.send('Runtime.evaluate', {
          expression: `(function(){ try { return chrome.runtime.getManifest().name; } catch (e) { return ''; } })()`,
          returnByValue: true
        });
        name = result?.result?.value || '';
        probe.close();
      } catch {
        // 某些内置 worker 不允许调试，跳过
      }
      if (name === 'AI 英译中助手') return target;
    }
    return null;
  }, 20000, 400, '本扩展 service worker 目标');
  assert.ok(swTarget, '扩展 service worker 应被唤醒');

  swCdp = new CDPClient(swTarget.webSocketDebuggerUrl);
  await swCdp.open();

  // 在扩展的真实 chrome.storage.local 中写入连接配置
  await check(`写入连接配置到扩展存储（${LIVE_MODE ? '真实 LM Studio' : 'mock 模型'}）`, async () => {
    const saved = await evaluate(swCdp, `chrome.storage.local.set({
      settings: {
        baseUrl: ${JSON.stringify(activeBaseUrl)},
        apiKey: ${JSON.stringify(activeApiKey)},
        model: ${JSON.stringify(activeModel)},
        styles: { originalColor: '#FFA500', translationColor: '#FF0000' }
      }
    }).then(() => 'saved')`);
    assert.equal(saved, 'saved');
  });

  // 清除未配置时产生的错误提示
  await evaluate(pageCdp, `document.querySelector('.et-close')?.click(); 'cleared'`);

  await check('划选英文后自动翻译，译文显示在原文下方', async () => {
    const selected = await evaluate(pageCdp, selectWord('world'));
    assert.equal(selected, 'world');

    const styles = await waitFor(async () => {
      const text = await evaluate(pageCdp, readTranslationText);
      return isReadyTranslation(text) ? evaluate(pageCdp, readStyles) : null;
    }, LIVE_MODE ? 150000 : 15000, 300, '译文出现');

    firstTranslationText = styles.translationText.replace('×', '').trim();
    assert.equal(styles.originalText, 'world');
    assert.ok(firstTranslationText.length > 0, '译文不应为空');
    if (!LIVE_MODE) {
      assert.equal(firstTranslationText, expectedTranslation);
    } else {
      assert.match(firstTranslationText, /[\u4e00-\u9fff]/, '真实模型译文应包含中文');
      assert.notEqual(firstTranslationText, 'world', '真实模型不应原样返回原文');
      assert.ok(!firstTranslationText.includes('只输出译文'), '真实模型不应回显系统提示词');
    }
    assert.equal(styles.belowOriginal, true);
  });

  await check('原文样式：加粗、放大、橙黄、非背景色', async () => {
    const styles = await evaluate(pageCdp, readStyles);
    assert.equal(styles.originalColor, 'rgb(255, 165, 0)');
    assert.equal(styles.originalWeight, '700');
    assert.ok(styles.originalSize > styles.baseSize, '原文字号应大于正文');
    assert.equal(styles.originalBackground, 'rgba(0, 0, 0, 0)');
  });

  await check('译文样式：红色、加粗、无下划线、稍小、非背景色', async () => {
    const styles = await evaluate(pageCdp, readStyles);
    assert.equal(styles.translationColor, 'rgb(255, 0, 0)');
    assert.equal(styles.translationWeight, '700');
    assert.equal(styles.translationDecoration, 'none');
    assert.ok(styles.translationSize < styles.baseSize, '译文字号应小于正文');
    assert.equal(styles.translationBackground, 'rgba(0, 0, 0, 0)');
  });

  await check('关闭后重新划选相同文本：命中缓存，不再次请求 AI', async () => {
    const before = chatRequests;
    if (!LIVE_MODE) {
      assert.equal(before, 1);
    }

    await evaluate(pageCdp, `document.querySelector('.et-close').click(); 'closed'`);
    await waitFor(async () =>
      (await evaluate(pageCdp, `!!document.querySelector('.et-translation')`)) === false,
      5000, 100, '旧译文移除');

    await evaluate(pageCdp, selectWord('world'));
    await waitFor(async () => {
      const text = await evaluate(pageCdp, readTranslationText);
      return text === firstTranslationText ? text : null;
    }, LIVE_MODE ? 150000 : 10000, 300, '缓存命中的译文出现');

    if (!LIVE_MODE) {
      assert.equal(chatRequests, before, '缓存命中后不应再次调用 AI');
    }
  });

  await check('插件内修改颜色后网页实时生效', async () => {
    await evaluate(swCdp, `chrome.storage.local.set({
      settings: {
        baseUrl: ${JSON.stringify(activeBaseUrl)},
        apiKey: ${JSON.stringify(activeApiKey)},
        model: ${JSON.stringify(activeModel)},
        styles: { originalColor: '#00AA00', translationColor: '#AA0000' }
      }
    }).then(() => 'updated')`);

    const styles = await waitFor(async () => {
      const value = await evaluate(pageCdp, readStyles);
      return value && value.originalColor === 'rgb(0, 170, 0)' ? value : null;
    }, 10000, 200, '颜色更新生效');

    assert.equal(styles.originalColor, 'rgb(0, 170, 0)');
    assert.equal(styles.translationColor, 'rgb(170, 0, 0)');
  });

  await check('真实 chrome.storage.local 中已存在翻译缓存', async () => {
    const cached = await evaluate(swCdp, `chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((key) => key.startsWith('cache:'));
      return { count: keys.length, entries: keys.map((key) => all[key]) };
    })`);
    assert.equal(cached.count, 1);
    assert.equal(cached.entries[0].from, 'en');
    assert.equal(cached.entries[0].to, 'zh');
    assert.equal(cached.entries[0].source, 'world');
    assert.equal(cached.entries[0].translated, firstTranslationText);
    assert.equal(cached.entries[0].hitCount, 2, '首次 AI 翻译 + 一次缓存命中');
  });

  // ---------- Popup 翻译工具 ----------
  const extensionId = swTarget.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
  assert.ok(extensionId, '应能解析出扩展 ID');
  await pageCdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/popup.html` });
  await waitFor(async () =>
    (await evaluate(pageCdp, `document.readyState === 'complete' && !!document.querySelector('#sourceText')`)) === true,
    15000, 200, 'Popup 页面加载');

  await check('翻译工具：输入英文单词 → 中文译文 + 缓存命中标记', async () => {
    const before = chatRequests;
    const entered = await evaluate(pageCdp, `(() => {
      const input = document.querySelector('#sourceText');
      input.value = 'world';
      document.querySelector('#btnTranslate').click();
      return input.value;
    })()`);
    assert.equal(entered, 'world');

    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#resultText')?.textContent || ''`)) === firstTranslationText,
      LIVE_MODE ? 30000 : 10000, 200, 'Popup 翻译结果');
    assert.equal(await evaluate(pageCdp, `document.querySelector('#resultMeta').textContent`), '✓ 缓存命中');
    if (!LIVE_MODE) {
      assert.equal(chatRequests, before, 'Popup 翻译应命中缓存，不请求 AI');
    }
  });

  await check('翻译工具：切换到中译英，输入中文 → 英文译文 + 缓存命中', async () => {
    await evaluate(pageCdp, `document.querySelector('#btnZhEn').click()`);
    assert.equal(await evaluate(pageCdp, `document.querySelector('#sourceLabel').textContent`), '中文原文');
    assert.equal(await evaluate(pageCdp, `document.querySelector('#btnTranslate').textContent`), '翻译成英文');

    await evaluate(pageCdp, `(() => {
      const input = document.querySelector('#sourceText');
      input.value = '世界';
      document.querySelector('#btnTranslate').click();
      return input.value;
    })()`);

    const first = await waitFor(async () => {
      const text = await evaluate(pageCdp, `document.querySelector('#resultText')?.textContent || ''`);
      const meta = await evaluate(pageCdp, `document.querySelector('#resultMeta')?.textContent || ''`);
      return text && meta ? { text, meta } : null;
    }, LIVE_MODE ? 150000 : 15000, 300, '中译英结果');
    zhToEnTranslationText = first.text;
    assert.equal(first.meta, '⚡ AI 翻译');
    if (!LIVE_MODE) {
      assert.equal(zhToEnTranslationText, 'world');
    } else {
      assert.match(zhToEnTranslationText, /[A-Za-z]/, '真实模型中译英结果应包含英文');
    }

    // 再次翻译同一中文：应命中 zh:en 缓存
    await evaluate(pageCdp, `document.querySelector('#btnTranslate').click()`);
    await waitFor(async () => {
      const text = await evaluate(pageCdp, `document.querySelector('#resultText')?.textContent || ''`);
      const meta = await evaluate(pageCdp, `document.querySelector('#resultMeta')?.textContent || ''`);
      return text === zhToEnTranslationText && meta === '✓ 缓存命中';
    }, LIVE_MODE ? 30000 : 10000, 300, '中译英缓存命中');
  });

  await check('设置页回显 Base URL 与自定义颜色', async () => {
    await evaluate(pageCdp, `document.querySelector('[data-tab="settings"]').click()`);
    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#baseUrl').value`)) === activeBaseUrl,
      5000, 150, '设置页读取 Base URL');
    assert.equal(await evaluate(pageCdp, `document.querySelector('#originalColorText').value`), '#00AA00');
    assert.equal(await evaluate(pageCdp, `document.querySelector('#translationColorText').value`), '#AA0000');
  });

  await check('测试连接按钮：获取模型列表并自动填入推荐模型', async () => {
    await evaluate(pageCdp, `document.querySelector('#model').value = ''`);
    await evaluate(pageCdp, `document.querySelector('#btnTest').click()`);

    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#settingsStatus').textContent`)).includes('连接成功'),
      LIVE_MODE ? 60000 : 10000, 300, '测试连接成功提示');

    const modelValue = await evaluate(pageCdp, `document.querySelector('#model').value`);
    assert.ok(modelValue, '应自动填入模型');
    if (!LIVE_MODE) {
      assert.equal(modelValue, 'mock-en-zh-model');
    } else {
      assert.notEqual(modelValue, 'omnitranslate-1.1', '应避开不兼容的翻译专用模型');
      const options = await evaluate(pageCdp, `Array.from(document.querySelectorAll('#modelList option')).map((option) => option.value)`);
      assert.ok(options.includes(modelValue), '自动填入的模型应来自模型列表');
    }
  });

  await check('缓存页显示翻译条目', async () => {
    await evaluate(pageCdp, `document.querySelector('[data-tab="cache"]').click()`);
    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#cacheList')?.textContent || ''`)).includes('world'),
      5000, 150, '缓存页条目渲染');
    const text = await evaluate(pageCdp, `document.querySelector('#cacheList').textContent`);
    assert.ok(text.includes(firstTranslationText), '缓存页应显示英译中译文');
    assert.ok(text.includes(zhToEnTranslationText), '缓存页应显示中译英译文');
  });
} finally {
  pageCdp?.close();
  swCdp?.close();
  try {
    await browserCdp?.send('Browser.close');
  } catch {
    // 浏览器可能已退出
  }
  browserCdp?.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!browserProcess.killed) browserProcess.kill();
  mockServer.closeAllConnections?.();
  await new Promise((resolve) => mockServer.close(resolve));
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n浏览器端到端测试全部通过：${passed} 组检查`);
