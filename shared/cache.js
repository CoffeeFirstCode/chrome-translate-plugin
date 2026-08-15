// 翻译缓存：写入 chrome.storage.local
// key 结构：cache:<from>:<to>:<原文长度>:<FNV-1a hash>，避免超长原文直接作为 storage key

import { CACHE_KEY_PREFIX } from './constants.js';

// 规范化原文：去首尾空白、压缩连续空白、英文统一小写
export function normalizeText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// FNV-1a 32 位 hash（同步、够快，缓存场景足够）
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return `${text.length.toString(36)}:${hash.toString(16).padStart(8, '0')}`;
}

export function buildCacheKey(from, to, text) {
  const normalized = normalizeText(text);
  return `${CACHE_KEY_PREFIX}${from}:${to}:${hashText(normalized)}`;
}

// 查询缓存；命中时更新 lastUsedAt / hitCount 并返回条目，未命中返回 null
export async function getCached(area, from, to, text) {
  const key = buildCacheKey(from, to, text);
  const result = await area.get(key);
  const entry = result?.[key];
  if (!entry) return null;

  entry.lastUsedAt = Date.now();
  entry.hitCount = Number(entry.hitCount || 0) + 1;
  await area.set({ [key]: entry });
  return entry;
}

// 写入缓存；source 保留原始大小写用于展示，key 使用规范化文本
export async function putCached(area, from, to, source, translated) {
  const key = buildCacheKey(from, to, source);
  const result = await area.get(key);
  const existing = result?.[key] || null;

  const entry = {
    key,
    from,
    to,
    source: String(source ?? '').trim(),
    translated: String(translated ?? '').trim(),
    createdAt: existing?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    hitCount: Number(existing?.hitCount || 0) + 1
  };
  await area.set({ [key]: entry });
  return entry;
}

// 列出全部缓存条目，按最近使用时间倒序
export async function listCached(area) {
  const all = await area.get(null);
  const entries = Object.entries(all || {})
    .filter(([key]) => key.startsWith(CACHE_KEY_PREFIX))
    .map(([, value]) => value)
    .filter(Boolean);
  entries.sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0));
  return entries;
}

// 清空全部缓存，返回删除条数
export async function clearAllCached(area) {
  const all = await area.get(null);
  const keys = Object.keys(all || {}).filter((key) => key.startsWith(CACHE_KEY_PREFIX));
  if (keys.length > 0) {
    await area.remove(keys);
  }
  return keys.length;
}

// 估算单条缓存占用字节数（用于「缓存」页展示）
export function estimateEntryBytes(entry) {
  try {
    return new TextEncoder().encode(JSON.stringify(entry)).length;
  } catch {
    return JSON.stringify(entry).length;
  }
}
