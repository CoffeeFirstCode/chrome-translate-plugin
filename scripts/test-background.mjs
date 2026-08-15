// 后台集成测试：用桩模拟 Chrome API，加载真实的 background/service-worker.js，
// 通过内置 mock OpenAI 服务验证完整消息处理链路。
// 运行：node scripts/test-background.mjs

import http from 'node:http';
import assert from 'node:assert/strict';

// ---------- Chrome API 桩 ----------
const storageData = new Map();
let messageListener = null;
let popupOpened = false;

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === null || key === undefined) {
          return Object.fromEntries(storageData);
        }
        if (typeof key === 'string') {
          return { [key]: storageData.get(key) };
        }
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map((item) => [item, storageData.get(item)]));
        }
        const result = {};
        for (const item of Object.keys(key)) result[item] = storageData.get(item);
        return result;
      },
      async set(object) {
        for (const [key, value] of Object.entries(object)) storageData.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storageData.delete(key);
      }
    },
    onChanged: {
      addListener() {}
    }
  },
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    }
  },
  action: {
    async openPopup() {
      popupOpened = true;
    }
  }
};

// ---------- mock OpenAI 服务 ----------
let chatRequests = 0;
const WORD_TABLE_EN2ZH = {
  hello: '你好',
  'machine learning': '机器学习'
};
const WORD_TABLE_ZH2EN = {
  你好: 'hello',
  世界: 'world',
  机器学习: 'machine learning'
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-en-zh-model' }]
    }));
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
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

// ---------- 加载真实 service worker ----------
await import('../background/service-worker.js');
assert.ok(messageListener, 'service worker 应注册 onMessage 监听器');

function call(message) {
  return new Promise((resolve, reject) => {
    const returned = messageListener(message, {}, resolve);
    assert.equal(returned, true, 'onMessage 应以异步方式返回 true');
    setTimeout(() => reject(new Error(`消息处理超时：${message.type}`)), 5000);
  });
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  console.log('后台消息链路（真实 service worker + mock OpenAI）');

  await check('默认设置', async () => {
    const response = await call({ type: 'settings:get' });
    assert.equal(response.ok, true);
    assert.equal(response.settings.baseUrl, 'http://127.0.0.1:1234/v1');
    assert.equal(response.settings.styles.originalColor, '#FFA500');
    assert.equal(response.settings.styles.translationColor, '#FF0000');
    assert.equal(response.configured, false);
  });

  await check('保存设置（含自定义颜色）', async () => {
    const response = await call({
      type: 'settings:save',
      settings: {
        baseUrl,
        apiKey: '',
        model: 'mock-en-zh-model',
        styles: { originalColor: '#123456', translationColor: '#ABCDEF' }
      }
    });
    assert.equal(response.ok, true);
    assert.equal(response.settings.styles.originalColor, '#123456');
    assert.equal(response.settings.styles.translationColor, '#ABCDEF');
  });

  await check('设置已持久化且 configured=true', async () => {
    const response = await call({ type: 'settings:get' });
    assert.equal(response.ok, true);
    assert.equal(response.settings.baseUrl, baseUrl);
    assert.equal(response.configured, true);
  });

  await check('测试连接并获取模型列表', async () => {
    const response = await call({ type: 'connection:test', settings: { baseUrl, apiKey: '' } });
    assert.equal(response.ok, true);
    assert.deepEqual(response.models, ['mock-en-zh-model']);
  });

  await check('首次翻译走 AI 并写缓存', async () => {
    const before = chatRequests;
    const response = await call({ type: 'translate', text: 'hello', from: 'en', to: 'zh' });
    assert.equal(response.ok, true);
    assert.equal(response.translated, '你好');
    assert.equal(response.cached, false);
    assert.equal(chatRequests, before + 1);
  });

  await check('相同文本（大小写/空白变化）命中缓存，不再请求 AI', async () => {
    const before = chatRequests;
    const response = await call({ type: 'translate', text: '  Hello ', from: 'en', to: 'zh' });
    assert.equal(response.ok, true);
    assert.equal(response.translated, '你好');
    assert.equal(response.cached, true);
    assert.equal(chatRequests, before);
  });

  await check('缓存统计与条目', async () => {
    const stats = await call({ type: 'cache:stats' });
    assert.equal(stats.ok, true);
    assert.equal(stats.count, 1);
    assert.ok(stats.bytes > 0);

    const entries = await call({ type: 'cache:entries', limit: 10 });
    assert.equal(entries.ok, true);
    assert.equal(entries.count, 1);
    assert.equal(entries.entries[0].source, 'hello');
    assert.equal(entries.entries[0].translated, '你好');
  });

  await check('清空缓存后再次翻译重新请求 AI', async () => {
    const cleared = await call({ type: 'cache:clear' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.removed, 1);

    const before = chatRequests;
    const response = await call({ type: 'translate', text: 'hello' });
    assert.equal(response.cached, false);
    assert.equal(chatRequests, before + 1);
  });

  await check('并发翻译同一文本只发起一次 AI 请求', async () => {
    await call({ type: 'cache:clear' });
    const before = chatRequests;
    const [first, second] = await Promise.all([
      call({ type: 'translate', text: 'machine learning' }),
      call({ type: 'translate', text: 'machine learning' })
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.translated, '机器学习');
    assert.equal(second.translated, '机器学习');
    assert.equal(chatRequests, before + 1);
  });

  await check('中译英：走 AI、写 zh:en 缓存、再次命中', async () => {
    const before = chatRequests;
    const first = await call({ type: 'translate', text: '世界', from: 'zh', to: 'en' });
    assert.equal(first.ok, true);
    assert.equal(first.translated, 'world');
    assert.equal(first.cached, false);
    assert.equal(chatRequests, before + 1);

    const second = await call({ type: 'translate', text: ' 世界 ', from: 'zh', to: 'en' });
    assert.equal(second.ok, true);
    assert.equal(second.translated, 'world');
    assert.equal(second.cached, true);
    assert.equal(chatRequests, before + 1, '中译英缓存命中不应再次请求 AI');

    const stats = await call({ type: 'cache:stats' });
    assert.equal(stats.ok, true);
    assert.ok(stats.pairs.includes('en→zh'));
    assert.ok(stats.pairs.includes('zh→en'));
  });

  await check('不支持的方向被拒绝', async () => {
    const response = await call({ type: 'translate', text: 'bonjour', from: 'fr', to: 'zh' });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'config');
  });

  await check('非法颜色被拒绝', async () => {
    const response = await call({
      type: 'settings:save',
      settings: { styles: { originalColor: 'red', translationColor: '#FF0000' } }
    });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'config');
  });

  await check('open-popup 消息', async () => {
    const response = await call({ type: 'open-popup' });
    assert.equal(response.ok, true);
    assert.equal(popupOpened, true);
  });
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

console.log(`\n后台集成测试全部通过：${passed} 组检查`);
