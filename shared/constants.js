// 全局默认配置与常量（background 通过 ES module 引用）

export const DEFAULT_SETTINGS = {
  // LM Studio 本地 OpenAI 兼容服务默认地址
  baseUrl: 'http://127.0.0.1:1234/v1',
  // LM Studio 本地服务通常不校验 key，可留空或填 lm-studio
  apiKey: '',
  // 模型名在 LM Studio 加载模型后，通过「测试连接 / 获取模型」自动填入
  model: '',
  // 划选自动翻译开关：默认关闭，避免随意选中文本就触发翻译
  selectionEnabled: false,
  styles: {
    originalColor: '#FFA500',   // 原文：橙黄色（仅字体颜色，非背景色）
    translationColor: '#FF0000' // 译文：红色（仅字体颜色，非背景色）
  }
};

export const DEFAULT_FROM = 'en';
export const DEFAULT_TO = 'zh';

// 单次翻译最大字符数
export const MAX_TEXT_LENGTH = 3000;

// AI 请求超时时间（本地 LM Studio 大模型首次推理可能较慢）
export const REQUEST_TIMEOUT_MS = 120000;

// 缓存 key 前缀，写入 chrome.storage.local
export const CACHE_KEY_PREFIX = 'cache:';

// 弹窗翻译历史最多保留条数
export const HISTORY_LIMIT = 20;

// 英译中翻译指令：只输出译文，避免模型输出解释
export const SYSTEM_PROMPT_EN2ZH =
  '你是专业英译中翻译引擎。把用户输入的英文翻译成简体中文：只输出译文本身，不要任何解释、拼音、注音或引号；' +
  '如果是单词，给出常见中文释义（多个释义用「；」分隔）；如果是句子，输出自然流畅的中文句子。';

// 中译英翻译指令
export const SYSTEM_PROMPT_ZH2EN =
  '你是专业中译英翻译引擎。把用户输入的中文翻译成英文：只输出译文本身，不要任何解释、音标、注音或引号；' +
  '如果是词语，给出常见英文释义（多个释义用「；」分隔）；如果是句子，输出自然流畅的英文句子。';

// 兼容旧引用：默认英译中
export const SYSTEM_PROMPT = SYSTEM_PROMPT_EN2ZH;
