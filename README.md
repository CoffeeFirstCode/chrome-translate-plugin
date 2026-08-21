# AI 英译中助手（Chrome 扩展）

一个 Chrome Manifest V3 翻译插件：

- **选中即译（仅英译中，带开关）**：在插件「翻译」页打开「划选自动翻译」开关后，网页划选英文文本才自动翻译（默认关闭）
  - 原文：加粗、字号变大、显示为插件内设置的橙黄色（仅字体颜色，非背景色）
  - 译文：显示在原文正下方，红色、加粗、字号稍小（仅字体颜色，非背景色，无下划线）
- **翻译工具（英译中 / 中译英）**：点击插件图标，可切换方向，输入单词或句子翻译（带复制、历史记录）
- **AI 接入**：OpenAI 兼容协议，可配置 `Base URL` 和 `API Key`，默认适配本地 **LM Studio**
- **翻译缓存**：已翻译的文本保存在 `chrome.storage.local`，下次遇到相同文本直接命中，不再调用 AI
- **缓存管理**：查看缓存条数与占用、搜索、一键清空全部缓存

---

## 安装（开发者模式）

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本插件所在文件夹（包含 `manifest.json` 的目录）

> 图标说明：仓库首次推送后，`.github/workflows/generate-icons.yml` 会自动生成并提交 `icons/*.png`；本地克隆后如果 `icons` 目录缺失，先运行 `node scripts/make-icons.js` 再加载扩展。

---

## 接入 LM Studio（本地模型）

1. 打开 **LM Studio**，下载并加载一个模型
2. 在 LM Studio 中启动本地服务器（Server），默认地址为 `http://127.0.0.1:1234/v1`
3. 点击浏览器工具栏的插件图标 → **设置**
   - `Base URL`：填 `http://127.0.0.1:1234/v1`
   - `API Key`：LM Studio 本地服务通常不校验，可留空或填 `lm-studio`
   - `模型名称`：点击「测试连接 / 获取模型」自动拉取并填入
4. 点击「保存设置」

> 说明：Base URL 已做安全限制——`http` 仅允许 `localhost / 127.0.0.1` 等本机地址，`https` 不限。

---

## 使用

### 网页选中翻译（仅英译中）

1. 点击插件图标 → **翻译**，打开顶部的「划选自动翻译」开关（默认关闭，开启后状态会保存）
2. 打开任意网页
3. 用鼠标划选一段英文（松开鼠标即可）
4. 原文立刻高亮（加粗、放大、橙黄色），下方自动出现红色加粗译文（无下划线）
5. 点译文右侧的 `×` 可关闭并还原原文；关闭「划选自动翻译」开关后，选中任何文字都不会触发翻译

### 翻译工具（英译中 / 中译英）

1. 点击插件图标 → **翻译**
2. 顶部选择方向：「英译中」或「中译英」
3. 输入英文或中文单词/句子（如 `machine learning` / `你好世界`）
4. 点「翻译成中文」/「翻译成英文」或按 `Ctrl + Enter`

### 样式设置

在「设置」页可修改：

| 项目 | 默认值 |
|---|---|
| 原文高亮颜色（仅字体颜色） | `#FFA500` 橙黄 |
| 译文颜色（仅字体颜色） | `#FF0000` 红 |

修改后点「保存设置」，网页中的样式立即生效（新翻译及已显示的译文）。

### 缓存

- 「缓存」页显示缓存总条数、占用空间和最近条目
- 支持按原文/译文搜索
- 「清空全部缓存」需要两次点击确认

---

## 目录结构

```
chrome-translate-plugin/
├── .github/
│   └── workflows/
│       └── generate-icons.yml # 首次推送后自动生成并提交 PNG 图标
├── manifest.json              # MV3 配置
├── background/
│   └── service-worker.js      # 翻译调度、缓存读写、设置
├── content/
│   ├── content.js             # 选中自动翻译、高亮、插入译文
│   └── content.css            # 高亮/译文样式（颜色走 CSS 变量）
├── popup/
│   ├── popup.html             # 翻译 / 设置 / 缓存 三个页签
│   ├── popup.css
│   └── popup.js
├── shared/
│   ├── constants.js           # 默认配置、常量、系统提示词
│   ├── cache.js               # 缓存 key/读写/清空
│   └── api.js                 # OpenAI 协议请求与错误映射
├── scripts/
│   ├── make-icons.js          # 生成 PNG 图标
│   ├── mock-openai.js         # 本地模拟 OpenAI 服务（无 LM Studio 时验证用）
│   ├── test-local.mjs         # 缓存/API 纯逻辑与 mock 接口测试
│   ├── test-background.mjs    # 后台消息链路集成测试
│   ├── test-browser.mjs       # 真实浏览器端到端测试（支持 mock / 真实 LM Studio）
│   ├── test-selection-toggle.mjs # 划选自动翻译开关链路端到端测试
│   └── test-lmstudio.mjs      # LM Studio 真实模型联调测试
└── icons/
```

---

## 本地自检（无需 LM Studio）

```bash
# 纯逻辑 + mock 接口测试（缓存、Base URL、OpenAI 请求、错误映射）
node scripts/test-local.mjs

# 后台集成测试（真实 service-worker.js + Chrome API 桩 + mock OpenAI）
node scripts/test-background.mjs

# 真实浏览器端到端测试（自动加载插件、模拟划选、校验样式与缓存）
node scripts/test-browser.mjs
```

> `test-browser.mjs` 会自动启动无头 **Edge**（新版正式版 Chrome 已禁用 `--load-extension` 开关，Edge 仍支持）。测试全程自动完成并自动关闭浏览器。

### LM Studio 真实模型联调（LM Studio 启动后）

```bash
# 直接验证 OpenAI 协议、真实译文与缓存模块
node scripts/test-lmstudio.mjs

# 真实浏览器全流程（划选翻译/样式/缓存/Popup 都走真实本地模型）
$env:LMSTUDIO_BASE_URL='http://127.0.0.1:1234/v1'
node scripts/test-browser.mjs
```

可选环境变量：`LMSTUDIO_MODEL`（指定模型名，默认自动取第一个）、`LMSTUDIO_API_KEY`（默认留空）。

如需在浏览器里不接真实模型手动验证插件，可先启动模拟服务：

```bash
node scripts/mock-openai.js
```

然后在插件设置里填：

- `Base URL`：`http://127.0.0.1:8787/v1`
- `API Key`：留空
- `模型名称`：`mock-en-zh-model`

---

## 常见问题

- **选中文字没反应**：确认「划选自动翻译」开关已开启（插件 → 翻译页顶部）、划选的是英文、长度不超过 3000 字符、已保存 Base URL 和模型；修改过插件代码后需在 `chrome://extensions/` 重新加载扩展并刷新网页；个别站点（浏览器内置页、商店页）不允许注入脚本。
- **提示 API Key 无效**：多数在线服务需要真实 Key；本地 LM Studio 可留空。
- **提示 404**：检查 Base URL 是否以 `/v1` 结尾，以及 LM Studio Server 是否已启动。
- **翻译很慢或超时**：首次加载模型较慢，可稍后重试；本地模型建议使用较小/量化模型提升速度。
