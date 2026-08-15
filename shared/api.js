// OpenAI 兼容协议请求封装（Chat Completions + Models）
// 适配 LM Studio：默认 http://127.0.0.1:1234/v1

import {
  REQUEST_TIMEOUT_MS,
  SYSTEM_PROMPT_EN2ZH,
  SYSTEM_PROMPT_ZH2EN
} from './constants.js';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;     // config | http | timeout | empty
    this.status = status; // HTTP 状态码，0 表示非 HTTP 错误
  }
}

function isLocalHttpHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

// 校验并规范化 Base URL：必须以 http(s):// 开头；http 仅允许本机地址
export function normalizeBaseUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url) {
    throw new ApiError('config', '请先在插件设置中配置 Base URL');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ApiError('config', 'Base URL 必须以 http:// 或 https:// 开头');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError('config', 'Base URL 格式不正确');
  }
  if (parsed.protocol === 'http:' && !isLocalHttpHost(parsed.hostname)) {
    throw new ApiError('config', '出于安全考虑，http 仅允许本机地址（localhost / 127.0.0.1）');
  }
  return url.replace(/\/+$/, '');
}

export function buildChatUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

export function buildModelsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  // 若用户粘贴了完整的 /chat/completions 地址，先回退到服务根路径
  const root = base.replace(/\/chat\/completions$/i, '');
  return /\/models$/i.test(root) ? root : `${root}/models`;
}

function statusMessage(status, data) {
  const detail = data?.error?.message || data?.message || data?._raw || '';
  const suffix = detail ? `（${String(detail).slice(0, 200)}）` : '';
  switch (status) {
    case 401:
    case 403:
      return `API Key 无效或无权限（${status}）${suffix}`;
    case 404:
      return `接口地址或模型不存在（404）${suffix}。LM Studio 的 Base URL 通常为 http://127.0.0.1:1234/v1`;
    case 429:
      return '请求过于频繁（429），请稍后再试';
    case 400:
      return `请求被拒绝（400）${suffix}，请检查模型名称和参数`;
    case 500:
    case 502:
    case 503:
      return `模型服务异常（${status}）${suffix}，请确认 LM Studio 已启动并加载模型`;
    default:
      return `请求失败（HTTP ${status}）${suffix}`;
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text.slice(0, 200) };
  }
}

// 清理模型输出：去空白、去代码块围栏、去外层引号、去「译文：」前缀
function cleanOutput(content, to = 'zh') {
  let out = String(content ?? '').trim();
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*/u, '').replace(/\s*```$/u, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  if (to === 'zh') {
    out = out.replace(/^(译文|翻译|中文译文)[:：]\s*/iu, '');
  } else {
    out = out.replace(/^(translation|english translation|英文译文)[:：]\s*/iu, '');
  }
  return out.trim();
}

function systemPromptFor(from, to) {
  return to === 'zh' ? SYSTEM_PROMPT_EN2ZH : SYSTEM_PROMPT_ZH2EN;
}

// OpenAI 协议翻译请求：POST {baseUrl}/chat/completions
// from/to 支持 en->zh 与 zh->en
export async function translateWithOpenAI({ baseUrl, apiKey, model, text, from = 'en', to = 'zh' }) {
  if (!model || !String(model).trim()) {
    throw new ApiError('config', '请先在插件设置中选择模型');
  }

  const url = buildChatUrl(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  const body = JSON.stringify({
    model: String(model).trim(),
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: systemPromptFor(from, to) },
      { role: 'user', content: String(text ?? '') }
    ]
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new ApiError('http', statusMessage(response.status, data), response.status);
    }

    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    const cleaned = cleanOutput(content, to);
    if (!cleaned) {
      throw new ApiError('empty', '模型返回了空内容，请确认模型已加载');
    }

    // 部分翻译专用模型不兼容 system prompt，会把提示词原样回显
    const ECHO_MARKERS = ['只输出译文本身', '不要任何解释', '专业英译中翻译引擎', '专业中译英翻译引擎'];
    if (ECHO_MARKERS.some((marker) => cleaned.includes(marker))) {
      throw new ApiError('model', '模型未按指令返回译文（疑似不兼容当前请求格式），请更换其他模型');
    }
    return cleaned;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('timeout', '请求超时（120 秒），请检查本地服务是否正常');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 获取模型列表：GET {baseUrl}/models（LM Studio 支持）
export async function listOpenAIModels({ baseUrl, apiKey }) {
  const url = buildModelsUrl(baseUrl);
  const headers = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000)
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new ApiError('http', statusMessage(response.status, data), response.status);
  }

  const models = Array.isArray(data?.data)
    ? data.data.map((item) => item?.id).filter(Boolean)
    : [];
  return models;
}
