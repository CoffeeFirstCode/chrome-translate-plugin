// Popup 逻辑：翻译工具 / 设置 / 缓存管理

(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    model: '',
    styles: { originalColor: '#FFA500', translationColor: '#FF0000' }
  };
  const HISTORY_KEY = 'history';
  const HISTORY_LIMIT = 20;
  const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

  const $ = (selector) => document.querySelector(selector);

  let cacheEntries = [];
  let clearConfirmTimer = null;
  let direction = { from: 'en', to: 'zh' }; // 当前翻译方向（仅主动翻译工具使用）

  // ---------- 消息通信 ----------

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, code: 'runtime', message: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, code: 'empty', message: '插件后台无响应' });
          }
        });
      } catch (error) {
        resolve({ ok: false, code: 'runtime', message: String(error?.message || error) });
      }
    });
  }

  function setStatus(element, text, isError) {
    element.textContent = text || '';
    element.classList.toggle('error', Boolean(isError));
  }

  // ---------- Tab 切换 ----------

  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        document.querySelectorAll('.panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `panel-${button.dataset.tab}`);
        });
      });
    });
  }

  // ---------- 设置 ----------

  function fillSettings(settings) {
    if (!settings) return;
    $('#baseUrl').value = settings.baseUrl ?? '';
    $('#apiKey').value = settings.apiKey ?? '';
    $('#model').value = settings.model ?? '';
    $('#selectionEnabled').checked = settings.selectionEnabled === true;
    const styles = settings.styles || {};
    $('#originalColor').value = styles.originalColor || DEFAULT_SETTINGS.styles.originalColor;
    $('#originalColorText').value = styles.originalColor || DEFAULT_SETTINGS.styles.originalColor;
    $('#translationColor').value = styles.translationColor || DEFAULT_SETTINGS.styles.translationColor;
    $('#translationColorText').value = styles.translationColor || DEFAULT_SETTINGS.styles.translationColor;
  }

  async function loadSettings() {
    const response = await send({ type: 'settings:get' });
    if (response.ok) {
      fillSettings(response.settings);
    } else {
      setStatus($('#settingsStatus'), response.message || '读取设置失败', true);
    }
  }

  function collectSettings() {
    const baseUrl = $('#baseUrl').value.trim();
    const originalColor = $('#originalColorText').value.trim().toUpperCase();
    const translationColor = $('#translationColorText').value.trim().toUpperCase();
    return {
      baseUrl,
      apiKey: $('#apiKey').value.trim(),
      model: $('#model').value.trim(),
      styles: { originalColor, translationColor }
    };
  }

  async function saveSettings() {
    const settings = collectSettings();
    if (!settings.baseUrl) {
      setStatus($('#settingsStatus'), '✗ 请填写 Base URL', true);
      return;
    }
    if (!COLOR_PATTERN.test(settings.styles.originalColor)) {
      setStatus($('#settingsStatus'), '✗ 原文颜色必须是 #RRGGBB 格式', true);
      return;
    }
    if (!COLOR_PATTERN.test(settings.styles.translationColor)) {
      setStatus($('#settingsStatus'), '✗ 译文颜色必须是 #RRGGBB 格式', true);
      return;
    }

    const button = $('#btnSave');
    button.disabled = true;
    setStatus($('#settingsStatus'), '保存中…');
    try {
      const response = await send({ type: 'settings:save', settings });
      if (response.ok) {
        fillSettings(response.settings);
        setStatus($('#settingsStatus'), '✓ 设置已保存');
      } else {
        setStatus($('#settingsStatus'), `✗ ${response.message || '保存失败'}`, true);
      }
    } finally {
      button.disabled = false;
    }
  }

  function renderModelList(models) {
    const datalist = $('#modelList');
    datalist.textContent = '';
    (models || []).forEach((id) => {
      const option = document.createElement('option');
      option.value = id;
      datalist.appendChild(option);
    });
  }

  // 自动选择模型时：优先指令微调模型，避开 embedding/翻译专用等与插件 system prompt 不兼容的模型
  function pickPreferredModel(models) {
    if (!Array.isArray(models) || models.length === 0) return '';
    const score = (id) => {
      const name = String(id || '').toLowerCase();
      let value = 0;
      if (/embed|rerank|whisper|tts|stt|asr|omnitranslate|translat/.test(name)) value -= 100;
      if (/qwen|gpt|llama|deepseek|glm|phi|mistral|gemma|command|instruct|chat|^yi-/.test(name)) value += 10;
      if (/vl|vision|multimodal|video/.test(name)) value -= 5;
      return value;
    };
    return [...models].sort((a, b) => score(b) - score(a))[0];
  }

  async function testConnection() {
    const settings = collectSettings();
    if (!settings.baseUrl) {
      setStatus($('#settingsStatus'), '✗ 请先填写 Base URL', true);
      return;
    }

    const button = $('#btnTest');
    button.disabled = true;
    setStatus($('#settingsStatus'), '正在连接…');
    try {
      const response = await send({ type: 'connection:test', settings });
      if (response.ok) {
        renderModelList(response.models || []);
        const preferred = pickPreferredModel(response.models || []);
        const autoFilled = Boolean(preferred && !settings.model);
        if (autoFilled) {
          $('#model').value = preferred;
        }
        setStatus(
          $('#settingsStatus'),
          `✓ ${response.message || '连接成功'}${autoFilled ? '（已自动填入模型，请点击「保存设置」）' : ''}`
        );
      } else {
        setStatus($('#settingsStatus'), `✗ ${response.message || '连接失败'}`, true);
      }
    } finally {
      button.disabled = false;
    }
  }

  function resetSettingsFields() {
    fillSettings(DEFAULT_SETTINGS);
    setStatus($('#settingsStatus'), '已恢复默认值，请点击「保存设置」生效');
  }

  // ---------- 翻译工具 ----------

  function setDirection(from, to) {
    direction = { from, to };
    const zhToEn = to === 'en';
    $('#btnEnZh').classList.toggle('active', !zhToEn);
    $('#btnZhEn').classList.toggle('active', zhToEn);
    $('#sourceLabel').textContent = zhToEn ? '中文原文' : '英文原文';
    $('#btnTranslate').textContent = zhToEn ? '翻译成英文' : '翻译成中文';
    $('#resultTitle').textContent = zhToEn ? '英文译文' : '中文译文';
    $('#sourceText').placeholder = zhToEn
      ? '输入中文词语或句子，例如：你好世界'
      : '输入英文单词或句子，例如：machine learning';
    $('#resultCard').classList.add('hidden');
    setStatus($('#translateStatus'), '');
  }

  async function doTranslate() {
    const text = $('#sourceText').value.trim();
    if (!text) {
      setStatus($('#translateStatus'), `✗ 请输入${direction.to === 'en' ? '中文' : '英文'}内容`, true);
      return;
    }

    const button = $('#btnTranslate');
    button.disabled = true;
    setStatus($('#translateStatus'), '翻译中…');
    $('#resultCard').classList.add('hidden');

    try {
      const response = await send({
        type: 'translate',
        text,
        from: direction.from,
        to: direction.to
      });
      if (response.ok) {
        $('#resultText').textContent = response.translated;
        $('#resultMeta').textContent = response.cached ? '✓ 缓存命中' : '⚡ AI 翻译';
        $('#resultCard').classList.remove('hidden');
        setStatus($('#translateStatus'), '');
        await addHistory({
          source: text,
          translated: response.translated,
          from: direction.from,
          to: direction.to,
          cached: Boolean(response.cached),
          ts: Date.now()
        });
      } else {
        setStatus($('#translateStatus'), `✗ ${response.message || '翻译失败'}`, true);
      }
    } finally {
      button.disabled = false;
    }
  }

  async function copyResult() {
    const text = $('#resultText').textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    const button = $('#btnCopy');
    const original = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => { button.textContent = original; }, 1200);
  }

  // ---------- 历史记录 ----------

  async function getHistory() {
    try {
      const result = await chrome.storage.local.get(HISTORY_KEY);
      return Array.isArray(result?.[HISTORY_KEY]) ? result[HISTORY_KEY] : [];
    } catch {
      return [];
    }
  }

  async function addHistory(item) {
    const existing = await getHistory();
    const list = [item, ...existing.filter((entry) =>
      !(entry.source === item.source &&
        (entry.from || 'en') === (item.from || 'en') &&
        (entry.to || 'zh') === (item.to || 'zh'))
    )].slice(0, HISTORY_LIMIT);
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: list });
    } catch {
      // 历史仅作辅助，存储失败忽略
    }
    renderHistory(list);
  }

  function renderHistory(list) {
    const container = $('#historyList');
    container.textContent = '';
    if (!list.length) {
      const item = document.createElement('li');
      item.className = 'empty';
      item.textContent = '暂无记录';
      container.appendChild(item);
      return;
    }
    list.forEach((entry) => {
      const from = entry.from || 'en';
      const to = entry.to || 'zh';
      const item = document.createElement('li');
      item.title = `${from} → ${to}：${entry.source} → ${entry.translated}`;
      const source = document.createElement('span');
      source.className = 'src';
      source.textContent = entry.source;
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = from === 'zh' ? '中→英' : '英→中';
      const target = document.createElement('span');
      target.className = 'dst';
      target.textContent = entry.translated;
      item.append(source, arrow, target);
      item.addEventListener('click', () => {
        $('#sourceText').value = entry.source;
        setDirection(from, to);
        $('#sourceText').focus();
      });
      container.appendChild(item);
    });
  }

  // ---------- 缓存管理 ----------

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  async function refreshCache() {
    const [statsResponse, entriesResponse] = await Promise.all([
      send({ type: 'cache:stats' }),
      send({ type: 'cache:entries', limit: 200 })
    ]);

    if (statsResponse.ok) {
      $('#cacheStats').textContent =
        `共 ${statsResponse.count} 条缓存 · 约 ${formatBytes(statsResponse.bytes)}` +
        (statsResponse.pairs?.length ? ` · ${statsResponse.pairs.join(' / ')}` : '');
    } else {
      $('#cacheStats').textContent = '读取缓存失败';
    }

    cacheEntries = entriesResponse.ok ? entriesResponse.entries : [];
    renderCache(cacheEntries);
  }

  function renderCache(list) {
    const query = $('#cacheSearch').value.trim().toLowerCase();
    const filtered = query
      ? list.filter((entry) =>
          String(entry.source || '').toLowerCase().includes(query) ||
          String(entry.translated || '').toLowerCase().includes(query)
        )
      : list;

    const container = $('#cacheList');
    container.textContent = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cache-empty';
      empty.textContent = query ? '无匹配结果' : '暂无缓存';
      container.appendChild(empty);
      return;
    }

    filtered.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'cache-item';

      const pair = document.createElement('div');
      pair.className = 'pair';
      const source = document.createElement('span');
      source.className = 'src';
      source.textContent = entry.source || '';
      source.title = entry.source || '';
      const arrow = document.createElement('span');
      arrow.textContent = '→';
      const target = document.createElement('span');
      target.className = 'dst';
      target.textContent = entry.translated || '';
      target.title = entry.translated || '';
      pair.append(source, arrow, target);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent =
        `${entry.from || 'en'} → ${entry.to || 'zh'} · ` +
        `${new Date(entry.lastUsedAt || Date.now()).toLocaleString()} · 命中 ${entry.hitCount || 0} 次`;

      item.append(pair, meta);
      container.appendChild(item);
    });
  }

  async function clearAllCache() {
    const response = await send({ type: 'cache:clear' });
    if (response.ok) {
      setStatus($('#translateStatus'), '');
      await refreshCache();
      $('#cacheStats').textContent =
        `已清空 ${response.removed} 条缓存 · 约 0 B`;
    }
  }

  function bindCacheClearButton() {
    const button = $('#btnClearCache');
    button.addEventListener('click', async () => {
      if (button.dataset.armed === '1') {
        clearTimeout(clearConfirmTimer);
        button.dataset.armed = '';
        button.textContent = '清空全部缓存';
        await clearAllCache();
        return;
      }
      button.dataset.armed = '1';
      button.textContent = '再次点击确认清空';
      clearConfirmTimer = setTimeout(() => {
        button.dataset.armed = '';
        button.textContent = '清空全部缓存';
      }, 3000);
    });
  }

  // ---------- 颜色输入联动 ----------

  function bindColor(picker, textInput) {
    picker.addEventListener('input', () => {
      textInput.value = picker.value.toUpperCase();
    });
    textInput.addEventListener('input', () => {
      const value = textInput.value.trim();
      if (COLOR_PATTERN.test(value)) {
        picker.value = value;
      }
    });
  }

  // ---------- 初始化 ----------

  function bindEvents() {
    bindTabs();

    $('#btnSave').addEventListener('click', saveSettings);
    $('#btnTest').addEventListener('click', testConnection);
    $('#btnReset').addEventListener('click', resetSettingsFields);
    $('#showKey').addEventListener('change', () => {
      $('#apiKey').type = $('#showKey').checked ? 'text' : 'password';
    });

    $('#btnTranslate').addEventListener('click', doTranslate);
    $('#btnCopy').addEventListener('click', copyResult);
    $('#btnEnZh').addEventListener('click', () => setDirection('en', 'zh'));
    $('#btnZhEn').addEventListener('click', () => setDirection('zh', 'en'));
    $('#selectionEnabled').addEventListener('change', async () => {
      const enabled = $('#selectionEnabled').checked;
      const response = await send({ type: 'settings:save', settings: { selectionEnabled: enabled } });
      if (response.ok) {
        setStatus($('#translateStatus'), enabled ? '✓ 划选自动翻译已开启' : '已关闭划选自动翻译');
      } else {
        setStatus($('#translateStatus'), `✗ ${response.message || '保存失败'}`, true);
      }
    });
    $('#sourceText').addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        doTranslate();
      }
    });

    $('#btnRefreshCache').addEventListener('click', refreshCache);
    bindCacheClearButton();
    $('#cacheSearch').addEventListener('input', () => renderCache(cacheEntries));

    bindColor($('#originalColor'), $('#originalColorText'));
    bindColor($('#translationColor'), $('#translationColorText'));
  }

  async function init() {
    bindEvents();
    setDirection('en', 'zh');
    renderHistory(await getHistory());
    await loadSettings();
    await refreshCache();
  }

  init();
})();
