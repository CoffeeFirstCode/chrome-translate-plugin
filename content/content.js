// Content Script：监听网页划选，选中英文后自动翻译（无需点击按钮）
// 原文：包裹 span 后加粗、字号放大、显示为设置的颜色（仅字体颜色）
// 译文：紧跟原文下方，红色、加粗、字号稍小（无下划线）

(() => {
  'use strict';

  const MAX_TEXT_LENGTH = 3000;
  const TRIGGER_DELAY_MS = 250;
  const CLASS_ORIGINAL = 'et-original';
  const CLASS_TRANSLATION = 'et-translation';
  const LOADING_TEXT = '翻译中…';
  const DEFAULT_ORIGINAL_COLOR = '#FFA500';
  const DEFAULT_TRANSLATION_COLOR = '#FF0000';

  let current = null; // { id, span, box, source, failed }
  let sequence = 0;
  let debounceTimer = null;
  let openedSettingsOnce = false;

  // ---------- 样式配置 ----------

  function applyStyles(styles) {
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--et-original-color', styles?.originalColor || DEFAULT_ORIGINAL_COLOR);
    root.style.setProperty('--et-translation-color', styles?.translationColor || DEFAULT_TRANSLATION_COLOR);
  }

  function loadStyles() {
    try {
      chrome.storage.local.get('settings').then((result) => {
        applyStyles(result?.settings?.styles);
      }).catch(() => {});
    } catch {
      // 扩展上下文失效时忽略
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes?.settings) {
        applyStyles(changes.settings.newValue?.styles);
      }
    });
  } catch {
    // ignore
  }

  loadStyles();

  // ---------- 工具函数 ----------

  function normalize(text) {
    return String(text ?? '').trim().replace(/\s+/g, ' ');
  }

  // 识别选区语言：英文为主 -> en；中文为主 -> zh；其他/空 -> null
  function detectLanguage(text) {
    const compact = text.replace(/\s+/g, '');
    if (!compact) return null;
    let latin = 0;
    let cjk = 0;
    for (const char of compact) {
      const code = char.codePointAt(0);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        latin += 1;
      } else if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      }
    }
    if (latin === 0 && cjk === 0) return null;
    if (cjk > latin) return 'zh';
    if (latin > cjk) return 'en';
    return 'zh'; // 中英字符数相同时按中文处理
  }

  function elementFor(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isInsideOwnUi(node) {
    let element = elementFor(node);
    while (element) {
      if (
        element.classList &&
        (element.classList.contains(CLASS_ORIGINAL) || element.classList.contains(CLASS_TRANSLATION))
      ) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function isEditable(node) {
    let element = elementFor(node);
    while (element) {
      if (element.isContentEditable) return true;
      const tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      element = element.parentElement;
    }
    return false;
  }

  // 包裹选区；跨节点选区降级为提取内容后包裹
  function wrapRange(range) {
    const span = document.createElement('span');
    span.className = CLASS_ORIGINAL;
    try {
      range.surroundContents(span);
    } catch {
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
    }
    return span;
  }

  function unwrapSpan(span) {
    const parent = span.parentNode;
    if (!parent) return;
    const fragment = document.createDocumentFragment();
    while (span.firstChild) {
      fragment.appendChild(span.firstChild);
    }
    parent.insertBefore(fragment, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function removeCurrent() {
    const old = current;
    current = null;
    if (!old) return;
    if (old.box?.parentNode) {
      old.box.remove();
    }
    if (old.span?.parentNode) {
      unwrapSpan(old.span);
    }
  }

  function makeCloseButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'et-close';
    button.textContent = '×';
    button.title = '关闭译文';
    button.setAttribute('aria-label', '关闭译文');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeCurrent();
    });
    return button;
  }

  function makeBox(text, kind) {
    const box = document.createElement('span');
    box.className = CLASS_TRANSLATION + (kind === 'error' ? ' et-error' : kind === 'loading' ? ' et-loading' : '');
    box.appendChild(document.createTextNode(text));
    box.appendChild(makeCloseButton());
    return box;
  }

  function setBoxText(box, text, kind) {
    if (!box) return;
    box.textContent = '';
    box.className = CLASS_TRANSLATION + (kind === 'error' ? ' et-error' : kind === 'loading' ? ' et-loading' : '');
    box.appendChild(document.createTextNode(text));
    box.appendChild(makeCloseButton());
  }

  function friendlyError(response) {
    if (response?.code === 'config') {
      return `无法翻译：${response.message || '请先完成插件设置'}（点击浏览器工具栏的插件图标进行配置）`;
    }
    return `翻译失败：${response.message || '未知错误'}`;
  }

  function runtimeErrorMessage(error) {
    const message = String(error?.message || error || '');
    if (/Extension context invalidated/i.test(message)) {
      return '插件已更新，请刷新当前页面后重试';
    }
    return `翻译失败：${message || '插件后台无响应，请重新加载扩展'}`;
  }

  function openPopupOnce() {
    if (openedSettingsOnce) return;
    openedSettingsOnce = true;
    try {
      chrome.runtime.sendMessage({ type: 'open-popup' }, () => void chrome.runtime.lastError);
    } catch {
      // ignore
    }
  }

  // ---------- 翻译流程 ----------

  function startTranslation(range, text, from, to) {
    const id = ++sequence;
    removeCurrent();

    let span;
    try {
      span = wrapRange(range);
    } catch {
      return;
    }

    const box = makeBox(LOADING_TEXT, 'loading');
    span.insertAdjacentElement('afterend', box);
    current = { id, span, box, source: normalize(text), failed: false };

    try {
      chrome.runtime.sendMessage(
        { type: 'translate', text, from, to },
        (response) => {
          if (chrome.runtime.lastError) {
            if (current && current.id === id) {
              setBoxText(current.box, runtimeErrorMessage(chrome.runtime.lastError.message), 'error');
              current.failed = true;
            }
            return;
          }
          if (!current || current.id !== id) return;

          if (response?.ok) {
            setBoxText(current.box, response.translated, 'done');
            current.failed = false;
          } else {
            setBoxText(current.box, friendlyError(response), 'error');
            current.failed = true;
            if (response?.code === 'config') {
              openPopupOnce();
            }
          }
        }
      );
    } catch (error) {
      if (current && current.id === id) {
        setBoxText(current.box, runtimeErrorMessage(error), 'error');
        current.failed = true;
      }
    }
  }

  function checkSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const rawText = selection.toString();
    const text = normalize(rawText);
    if (!text) return;
    if (text.length > MAX_TEXT_LENGTH) return;

    const language = detectLanguage(text);
    // 划选高亮翻译：仅支持英译中（中译英在 Popup 主动翻译工具中使用）
    if (language !== 'en') return;
    const from = 'en';
    const to = 'zh';

    const anchor = range.commonAncestorContainer;
    if (isInsideOwnUi(anchor) || isEditable(anchor)) return;

    // 同一个选区已经翻译过（且未失败）则不重复触发；失败后重选可重试
    if (current && current.source === text && !current.failed) return;

    startTranslation(range.cloneRange(), rawText.trim(), from, to);
  }

  function scheduleCheck() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkSelection, TRIGGER_DELAY_MS);
  }

  document.addEventListener('mouseup', scheduleCheck, true);
  document.addEventListener('touchend', scheduleCheck, true);
  document.addEventListener(
    'keyup',
    (event) => {
      if (
        event.key === 'Shift' ||
        event.key.startsWith('Arrow') ||
        event.key === 'Home' ||
        event.key === 'End'
      ) {
        scheduleCheck();
      }
    },
    true
  );
})();
