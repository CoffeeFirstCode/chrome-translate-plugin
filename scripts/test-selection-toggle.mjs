// 复现测试：划选自动翻译开关「启用/禁用」端到端链路
//   node scripts/test-selection-toggle.mjs
// 链路：Popup 开关 change → settings:save → background 合并写入 storage → content script onChanged → 划选翻译
// 每个环节都直接断言，失败即定位到断点。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER_PATH = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');

let chatRequests = 0;
const mockServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/page') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"></head>
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
      res.end(JSON.stringify({
        choices: [{ message: { content: '模拟译文' } }]
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
const pageUrl = `http://127.0.0.1:${mockPort}/page`;

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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
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

const selectWord = `(() => {
  const textNode = document.querySelector('#text').firstChild;
  const index = textNode.textContent.indexOf('world');
  const range = document.createRange();
  range.setStart(textNode, index);
  range.setEnd(textNode, index + 5);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  return selection.toString();
})()`;

const translationText = `(() => {
  const element = document.querySelector('.et-translation');
  return element ? element.textContent.replace('×', '').trim() : null;
})()`;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

assert.ok(fs.existsSync(BROWSER_PATH), `未找到浏览器，跳过测试`);
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

try {
  const debugPort = await waitFor(async () => {
    const file = path.join(PROFILE_DIR, 'DevToolsActivePort');
    if (!fs.existsSync(file)) return null;
    return Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]);
  }, 30000, 300, 'DevToolsActivePort');

  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return response.ok ? response.json() : null;
  }, 15000, 300, 'version endpoint');

  browserCdp = new CDPClient(version.webSocketDebuggerUrl);
  await browserCdp.open();

  const pageTarget = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    return targets.find((target) => target.type === 'page');
  }, 15000, 300, 'page target');

  pageCdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await pageCdp.open();
  await pageCdp.send('Page.navigate', { url: pageUrl });
  await waitFor(async () => (await evaluate(pageCdp, 'document.readyState')) === 'complete', 15000, 200, '测试页加载');

  // 唤醒 service worker
  await evaluate(pageCdp, selectWord);
  const swTarget = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    for (const target of targets.filter((t) => t.type === 'service_worker')) {
      try {
        const probe = new CDPClient(target.webSocketDebuggerUrl);
        await probe.open();
        const result = await probe.send('Runtime.evaluate', {
          expression: `(function(){ try { return chrome.runtime.getManifest().name; } catch { return ''; } })()`,
          returnByValue: true
        });
        probe.close();
        if (result?.result?.value === 'AI 英译中助手') return target;
      } catch { /* ignore */ }
    }
    return null;
  }, 20000, 400, '扩展 service worker');

  swCdp = new CDPClient(swTarget.webSocketDebuggerUrl);
  await swCdp.open();

  const extensionId = swTarget.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];

  // 基础配置（模拟用户已配置好 Base URL / 模型；不包含 selectionEnabled）
  await evaluate(swCdp, `chrome.storage.local.set({ settings: {
    baseUrl: 'http://127.0.0.1:${mockPort}/v1', apiKey: '', model: 'mock-en-zh-model',
    styles: { originalColor: '#FFA500', translationColor: '#FF0000' }
  }}).then(() => 'saved')`);

  const openPopup = async () => {
    await pageCdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/popup.html` });
    await waitFor(async () =>
      (await evaluate(pageCdp, `document.readyState === 'complete' && !!document.querySelector('#sourceText')`)) === true,
      15000, 200, 'Popup 页面加载');
    // 等 loadSettings 异步完成（baseUrl 回填）
    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#baseUrl').value`))?.startsWith('http://127.0.0.1:'),
      5000, 150,
      'Popup settings 加载（当前状态=' + JSON.stringify({
        baseUrl: await evaluate(pageCdp, `document.querySelector('#baseUrl').value`),
        status: await evaluate(pageCdp, `document.querySelector('#settingsStatus').textContent`),
        origin: await evaluate(pageCdp, `location.origin`)
      }) + ')');
  };

  const storageSelectionEnabled = () =>
    evaluate(swCdp, `chrome.storage.local.get('settings').then((r) => r.settings?.selectionEnabled === true)`);

  const switchChecked = () => evaluate(pageCdp, `document.querySelector('#selectionEnabled').checked`);
  const clickSwitch = () => evaluate(pageCdp, `document.querySelector('#selectionEnabled').click(); 'clicked'`);
  const goPage = () => pageCdp.send('Page.navigate', { url: pageUrl });

  // ---------- 链路 1：启用开关 ----------
  await check('打开 Popup，初始开关为关闭', async () => {
    await openPopup();
    assert.equal(await switchChecked(), false);
  });

  await check('点击开关 → storage 中 selectionEnabled=true', async () => {
    await clickSwitch();
    await waitFor(async () => await storageSelectionEnabled(), 5000, 150, 'selectionEnabled=true 写入');
    assert.equal(await switchChecked(), true);
  });

  await check('启用后：网页划选英文出现译文', async () => {
    await goPage();
    await waitFor(async () => (await evaluate(pageCdp, 'document.readyState')) === 'complete', 10000, 200, '页面加载');
    await evaluate(pageCdp, selectWord);
    await waitFor(async () => {
      const text = await evaluate(pageCdp, translationText);
      return text && !text.includes('翻译中') ? text : null;
    }, 15000, 300, '译文出现');
  });

  // ---------- 链路 2：禁用开关 ----------
  await check('再开 Popup（回显已开启状态），点击关闭 → storage=false', async () => {
    await openPopup();
    assert.equal(await switchChecked(), true, 'Popup 应回显开启状态');
    await clickSwitch();
    await waitFor(async () => !(await storageSelectionEnabled()), 5000, 150, 'selectionEnabled=false 写入');
    assert.equal(await switchChecked(), false);
  });

  await check('禁用后：网页划选不再翻译', async () => {
    await goPage();
    await waitFor(async () => (await evaluate(pageCdp, 'document.readyState')) === 'complete', 10000, 200, '页面加载');
    await evaluate(pageCdp, `document.querySelector('.et-close')?.click(); 'cleared'`);
    const before = chatRequests;
    await evaluate(pageCdp, selectWord);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const text = await evaluate(pageCdp, translationText);
    assert.equal(text, null, '禁用后不应出现译文');
    assert.equal(chatRequests, before, '禁用后不应产生 AI 请求');
  });

  // ---------- 链路 3：设置页「保存设置」不应破坏开关状态 ----------
  await check('设置页点击「保存设置」后开关状态保持', async () => {
    await openPopup();
    await clickSwitch();
    await waitFor(async () => await storageSelectionEnabled(), 5000, 150, '先重新开启');
    await evaluate(pageCdp, `(() => {
      document.querySelector('[data-tab="settings"]').click();
      document.querySelector('#btnSave').click();
      return 'saved';
    })()`);
    await waitFor(async () =>
      (await evaluate(pageCdp, `document.querySelector('#settingsStatus').textContent`)).includes('已保存'),
      5000, 150, '设置保存完成');
    assert.equal(await storageSelectionEnabled(), true, '保存设置不应清掉开关');
  });

  console.log(`\n划选开关链路测试全部通过：${passed} 组检查`);
} finally {
  pageCdp?.close();
  swCdp?.close();
  try { await browserCdp?.send('Browser.close'); } catch { /* ignore */ }
  browserCdp?.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!browserProcess.killed) browserProcess.kill();
  mockServer.closeAllConnections?.();
  await new Promise((resolve) => mockServer.close(resolve));
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}