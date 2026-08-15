// 本地自检脚本（不依赖 Chrome）：
//   1) 缓存模块纯逻辑测试（规范化、key、读写、清空）
//   2) Base URL 校验测试
//   3) 用内置 mock OpenAI 服务验证 API 请求/解析/错误映射
// 运行：node scripts/test-local.mjs

import http from 'node:http';
import assert from 'node:assert/strict';

import {
  normalizeBaseUrl,
  buildChatUrl,
  buildModelsUrl,
  ApiError,
  translateWithOpenAI,
  listOpenAIModels
} from '../shared/api.js';
import {
  normalizeText,
  buildCacheKey,
  getCached,
  putCached,
  listCached,
  clearAllCached,
  estimateEntryBytes
} from '../shared/cache.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------- Base URL 校验 ----------
console.log('Base URL 校验');
await check('去掉末尾斜杠', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
});
await check('拒绝无协议地址', () => {
  assert.throws(() => normalizeBaseUrl('127.0.0.1:1234'), /http/);
});
await check('拒绝非本机 http', () => {
  assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /仅允许本机/);
});
await check('拼接 chat/models 端点', () => {
  assert.equal(buildChatUrl('http://127.0.0.1:8787/v1'), 'http://127.0.0.1:8787/v1/chat/completions');
  assert.equal(buildModelsUrl('http://127.0.0.1:8787/v1'), 'http://127.0.0.1:8787/v1/models');
  assert.equal(buildModelsUrl('http://127.0.0.1:8787/v1/chat/completions'), 'http://127.0.0.1:8787/v1/models');
});

// ---------- 缓存模块 ----------
console.log('缓存模块');
function fakeArea() {
  const data = new Map();
  return {
    async get(key) {
      if (key === null) return Object.fromEntries(data);
      return { [key]: data.get(key) };
    },
    async set(object) {
      for (const [key, value] of Object.entries(object)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    }
  };
}

await check('规范化文本（空白/大小写）', () => {
  assert.equal(normalizeText('  Hello   World '), 'hello world');
});
await check('相同文本生成相同 key', () => {
  assert.equal(buildCacheKey('en', 'zh', 'Hello World'), buildCacheKey('en', 'zh', '  hello  world '));
});
await check('写入 → 命中 → 计数 → 清空', async () => {
  const area = fakeArea();
  const entry = await putCached(area, 'en', 'zh', 'Hello   World', '你好，世界');
  assert.equal(entry.source, 'Hello   World');

  const hit = await getCached(area, 'en', 'zh', 'HELLO world');
  assert.ok(hit);
  assert.equal(hit.translated, '你好，世界');
  assert.equal(hit.hitCount, 2);

  const miss = await getCached(area, 'en', 'zh', 'another word');
  assert.equal(miss, null);

  const list = await listCached(area);
  assert.equal(list.length, 1);
  assert.equal(typeof estimateEntryBytes(list[0]), 'number');

  const removed = await clearAllCached(area);
  assert.equal(removed, 1);
  assert.equal((await listCached(area)).length, 0);
});

// ---------- mock OpenAI 服务 + API 模块 ----------
console.log('OpenAI 协议请求（内置 mock 服务）');

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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      if (req.headers.authorization && req.headers.authorization !== 'Bearer mock-key') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
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

try {
  await check('获取模型列表', async () => {
    const models = await listOpenAIModels({ baseUrl, apiKey: '' });
    assert.deepEqual(models, ['mock-en-zh-model']);
  });

  await check('单词翻译', async () => {
    const result = await translateWithOpenAI({ baseUrl, apiKey: '', model: 'mock-en-zh-model', text: 'hello' });
    assert.equal(result, '你好');
  });

  await check('句子翻译', async () => {
    const result = await translateWithOpenAI({ baseUrl, apiKey: '', model: 'mock-en-zh-model', text: 'machine learning' });
    assert.equal(result, '机器学习');
  });

  await check('中译英（zh→en）', async () => {
    const result = await translateWithOpenAI({ baseUrl, apiKey: '', model: 'mock-en-zh-model', text: '世界', from: 'zh', to: 'en' });
    assert.equal(result, 'world');
  });

  await check('401 错误映射', async () => {
    await assert.rejects(
      () => translateWithOpenAI({ baseUrl, apiKey: 'bad-key', model: 'mock-en-zh-model', text: 'hello' }),
      (error) => error instanceof ApiError && error.status === 401 && /API Key/.test(error.message)
    );
  });

  await check('404 错误映射', async () => {
    await assert.rejects(
      () => listOpenAIModels({ baseUrl: `${baseUrl}/wrong`, apiKey: '' }),
      (error) => error instanceof ApiError && error.status === 404
    );
  });

  await check('缺少模型时给出配置错误', async () => {
    await assert.rejects(
      () => translateWithOpenAI({ baseUrl, apiKey: '', model: '', text: 'hello' }),
      (error) => error instanceof ApiError && error.code === 'config'
    );
  });
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

console.log(`\n全部通过：${passed} 组检查`);
