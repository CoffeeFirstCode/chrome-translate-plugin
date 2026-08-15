// Background Service Worker：统一处理翻译请求、设置读写、缓存管理
// 翻译流程：规范化文本 → 查缓存 → 命中直接返回 → 未命中调用 OpenAI 协议接口 → 写缓存

import { DEFAULT_SETTINGS, MAX_TEXT_LENGTH } from '../shared/constants.js';
import {
  ApiError,
  normalizeBaseUrl,
  translateWithOpenAI,
  listOpenAIModels
} from '../shared/api.js';
import {
  buildCacheKey,
  getCached,
  putCached,
  listCached,
  clearAllCached,
  estimateEntryBytes
} from '../shared/cache.js';

const STORAGE = chrome.storage.local;
const SETTINGS_KEY = 'settings';
const SUPPORTED_PAIRS = new Set(['en:zh', 'zh:en']);

// 相同文本并发翻译去重：key -> Promise
const inflight = new Map();

async function getSettings() {
  const result = await STORAGE.get(SETTINGS_KEY);
  const saved = result?.[SETTINGS_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    styles: { ...DEFAULT_SETTINGS.styles, ...(saved.styles || {}) }
  };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await STORAGE.set({ [SETTINGS_KEY]: next });
  return next;
}

function isHexColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}

// 只接收允许的字段并校验
function validateSettingsPatch(patch) {
  const source = patch || {};
  const clean = {};
  if (Object.prototype.hasOwnProperty.call(source, 'baseUrl')) {
    clean.baseUrl = normalizeBaseUrl(source.baseUrl);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'apiKey')) {
    clean.apiKey = String(source.apiKey ?? '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(source, 'model')) {
    clean.model = String(source.model ?? '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(source, 'selectionEnabled')) {
    clean.selectionEnabled = Boolean(source.selectionEnabled);
  }
  if (source.styles) {
    const originalColor = String(source.styles.originalColor ?? '').trim().toUpperCase();
    const translationColor = String(source.styles.translationColor ?? '').trim().toUpperCase();
    if (!isHexColor(originalColor)) {
      throw new ApiError('config', '原文颜色必须是 #RRGGBB 格式');
    }
    if (!isHexColor(translationColor)) {
      throw new ApiError('config', '译文颜色必须是 #RRGGBB 格式');
    }
    clean.styles = { originalColor, translationColor };
  }
  return clean;
}

async function handleSettingsGet() {
  const settings = await getSettings();
  return {
    ok: true,
    settings,
    configured: Boolean(settings.baseUrl && settings.model),
    hasApiKey: Boolean(settings.apiKey)
  };
}

async function handleSettingsSave(message) {
  const patch = validateSettingsPatch(message?.settings || {});
  const settings = await saveSettings(patch);
  return { ok: true, settings };
}

// 测试连接：优先用 /models 接口（顺便拉取模型列表）；
// 个别服务不支持 /models 时，回退用一条极短翻译请求验证。
async function handleTestConnection(message) {
  const raw = message?.settings || {};
  const baseUrl = normalizeBaseUrl(raw.baseUrl ?? '');
  const apiKey = String(raw.apiKey ?? '').trim();
  const model = String(raw.model ?? '').trim();

  try {
    const models = await listOpenAIModels({ baseUrl, apiKey });
    return {
      ok: true,
      models,
      message: models.length
        ? `连接成功，找到 ${models.length} 个模型`
        : '连接成功（服务未返回模型列表）'
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      if (!model) {
        throw new ApiError('config', '模型列表接口不可用，请先手动填写模型名称再测试');
      }
      await translateWithOpenAI({ baseUrl, apiKey, model, text: 'hello' });
      return { ok: true, models: [], message: '连接成功（模型列表接口不可用，已通过翻译接口验证）' };
    }
    throw error;
  }
}

async function handleTranslate(message) {
  const text = String(message?.text ?? '').trim();
  if (!text) {
    throw new ApiError('config', '没有可翻译的文本');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ApiError('config', `文本过长，单次最多支持 ${MAX_TEXT_LENGTH} 个字符`);
  }

  const from = String(message?.from || 'en');
  const to = String(message?.to || 'zh');
  if (!SUPPORTED_PAIRS.has(`${from}:${to}`)) {
    throw new ApiError('config', '仅支持英译中（en→zh）或中译英（zh→en）');
  }
  const settings = await getSettings();

  if (!settings.baseUrl) {
    throw new ApiError('config', '请先在插件设置中配置 Base URL');
  }
  if (!settings.model) {
    throw new ApiError('config', '请先在插件设置中选择模型');
  }

  const cacheKey = buildCacheKey(from, to, text);

  // 1. 缓存命中，直接返回，不调用 AI
  const hit = await getCached(STORAGE, from, to, text);
  if (hit) {
    return { ok: true, translated: hit.translated, cached: true, from, to };
  }

  // 2. 未命中：调用 AI（相同文本并发请求共享同一个 Promise）
  let task = inflight.get(cacheKey);
  if (!task) {
    task = (async () => {
      const translated = await translateWithOpenAI({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        text,
        from,
        to
      });
      return putCached(STORAGE, from, to, text, translated);
    })();
    inflight.set(cacheKey, task);
  }

  try {
    const entry = await task;
    return { ok: true, translated: entry.translated, cached: false, from, to };
  } finally {
    if (inflight.get(cacheKey) === task) {
      inflight.delete(cacheKey);
    }
  }
}

async function handleCacheStats() {
  const entries = await listCached(STORAGE);
  const bytes = entries.reduce((sum, entry) => sum + estimateEntryBytes(entry), 0);
  const pairs = [...new Set(entries.map((entry) => `${entry.from}→${entry.to}`))];
  return { ok: true, count: entries.length, bytes, pairs };
}

async function handleCacheEntries(message) {
  const limit = Math.max(1, Math.min(Number(message?.limit) || 200, 500));
  const entries = await listCached(STORAGE);
  return { ok: true, count: entries.length, entries: entries.slice(0, limit) };
}

async function handleCacheClear() {
  const removed = await clearAllCached(STORAGE);
  return { ok: true, removed };
}

async function handleOpenPopup() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
    }
  } catch {
    // 部分环境（无用户手势等）不允许程序化打开，忽略即可
  }
  return { ok: true };
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'settings:get':
      return handleSettingsGet();
    case 'settings:save':
      return handleSettingsSave(message);
    case 'connection:test':
      return handleTestConnection(message);
    case 'translate':
      return handleTranslate(message);
    case 'cache:stats':
      return handleCacheStats();
    case 'cache:entries':
      return handleCacheEntries(message);
    case 'cache:clear':
      return handleCacheClear();
    case 'open-popup':
      return handleOpenPopup();
    default:
      throw new ApiError('config', `未知消息类型：${message?.type || '(空)'}`);
  }
}

function toError(error) {
  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message, status: error.status };
  }
  return {
    ok: false,
    code: 'unknown',
    message: error?.message || String(error || '未知错误')
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(toError(error)));
  return true; // 异步 sendResponse
});
