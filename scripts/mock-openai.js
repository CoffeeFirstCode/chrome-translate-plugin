// 本地模拟 OpenAI 兼容接口（用于在没有 LM Studio 时验证插件）
// 用法：node scripts/mock-openai.js   （默认端口 8787，可用环境变量 PORT 修改）
// 然后在插件设置里填：Base URL = http://127.0.0.1:8787/v1，API Key 留空，模型 = mock-en-zh-model

const http = require('http');

const PORT = Number(process.env.PORT || 8787);

const WORD_TABLE_EN2ZH = {
  hello: '你好',
  world: '世界',
  'machine learning': '机器学习',
  translation: '翻译',
  ai: '人工智能',
  'artificial intelligence': '人工智能',
  test: '测试',
  'this is a test': '这是一个测试'
};

const WORD_TABLE_ZH2EN = {
  你好: 'hello',
  世界: 'world',
  机器学习: 'machine learning',
  翻译: 'translation',
  人工智能: 'artificial intelligence',
  测试: 'test',
  你好世界: 'hello world'
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-en-zh-model', object: 'model', owned_by: 'mock' }]
    }));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }

      const auth = req.headers.authorization || '';
      if (auth && auth !== 'Bearer mock-key') {
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

      const translated = zhToEn
        ? (WORD_TABLE_ZH2EN[text] || `【mock EN】${text}`)
        : (WORD_TABLE_EN2ZH[text] || `【模拟译文】${text}`);
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'mock-en-zh-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: translated },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock OpenAI server: http://127.0.0.1:${PORT}/v1`);
});
