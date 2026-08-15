// LM Studio 真实模型联调测试（需要 LM Studio 已启动 Local Server 并加载模型）
// 用法：
//   node scripts/test-lmstudio.mjs
// 可选环境变量：
//   LMSTUDIO_BASE_URL  默认 http://127.0.0.1:1234/v1
//   LMSTUDIO_API_KEY   默认留空（LM Studio 本地服务通常不校验）
//   LMSTUDIO_MODEL     默认自动使用模型列表第一个

import assert from 'node:assert/strict';
import {
  listOpenAIModels,
  translateWithOpenAI
} from '../shared/api.js';
import {
  getCached,
  putCached,
  listCached
} from '../shared/cache.js';

const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
const apiKey = process.env.LMSTUDIO_API_KEY || '';
const requestedModel = process.env.LMSTUDIO_MODEL || '';

console.log(`连接 LM Studio：${baseUrl}`);

// 1. 获取模型列表
let models;
try {
  models = await listOpenAIModels({ baseUrl, apiKey });
} catch (error) {
  console.error(`✗ 获取模型列表失败：${error.message}`);
  console.error('请确认：1) LM Studio 已启动 Local Server；2) 已加载模型；3) 端口为 1234');
  process.exit(2);
}

console.log(`✓ 连接成功，可用模型 ${models.length} 个：${models.slice(0, 10).join(', ')}${models.length > 10 ? ' …' : ''}`);
if (models.length === 0) {
  console.error('✗ 没有可用模型，请先在 LM Studio 中加载模型');
  process.exit(2);
}

const model = requestedModel || models[0];
console.log(`使用模型：${model}`);

function assertChinese(text, label) {
  assert.match(String(text), /[\u4e00-\u9fff]/, `${label} 的译文应包含中文`);
}

function assertNotPromptEcho(translated, label) {
  const markers = ['只输出译文本身', '不要任何解释', '专业英译中翻译引擎', '专业中译英翻译引擎'];
  assert.ok(
    !markers.some((marker) => String(translated).includes(marker)),
    `${label} 不应回显系统提示词（该模型可能不兼容当前请求格式）`
  );
}

// 2. 真实模型翻译（英译中单词、英译中句子、中译英）
const samples = [
  { text: 'Hello', from: 'en', to: 'zh' },
  { text: 'Machine learning is very useful.', from: 'en', to: 'zh' },
  { text: '你好世界', from: 'zh', to: 'en' }
];
const results = [];
for (const sample of samples) {
  const startedAt = Date.now();
  let translated;
  try {
    translated = await translateWithOpenAI({
      baseUrl,
      apiKey,
      model,
      text: sample.text,
      from: sample.from,
      to: sample.to
    });
  } catch (error) {
    console.error(`✗ 翻译失败（${sample.text}）：${error.message}`);
    process.exit(2);
  }
  console.log(`✓ [${sample.from}→${sample.to}] ${sample.text}\n  -> ${translated}（${Date.now() - startedAt}ms）`);
  assertNotPromptEcho(translated, sample.text);
  assert.notEqual(translated.trim().toLowerCase(), sample.text.toLowerCase(), `${sample.text} 不应原样返回`);
  if (sample.to === 'zh') {
    assertChinese(translated, sample.text);
  } else {
    assert.match(String(translated), /[A-Za-z]/, `${sample.text} 的中译英结果应包含英文`);
  }
  results.push(translated);
}

// 3. 用真实译文验证缓存模块
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

const area = fakeArea();
await putCached(area, 'en', 'zh', 'Hello', results[0]);
const hit = await getCached(area, 'en', 'zh', '  hello ');
assert.equal(hit.translated, results[0], '英译中缓存应返回与首次翻译一致的结果');
assert.equal(hit.hitCount, 2);

await putCached(area, 'zh', 'en', '你好世界', results[2]);
const hitReverse = await getCached(area, 'zh', 'en', ' 你好世界 ');
assert.equal(hitReverse.translated, results[2], '中译英缓存应返回与首次翻译一致的结果');
assert.equal(hitReverse.hitCount, 2);
assert.equal((await listCached(area)).length, 2);
console.log('✓ 双向缓存读写与命中验证通过（en:zh、zh:en 各 1 条）');

console.log('\nLM Studio 真实模型联调测试全部通过');
