/**
 * server.js - Express server providing OpenAI and Anthropic compatible API
 *
 * Endpoints:
 *   GET  /v1/models                 - List available models
 *   GET  /v1/status                 - Server status
 *   POST /v1/chat/completions       - OpenAI chat completions
 *   POST /v1/messages               - Anthropic messages
 */

require('dotenv').config();

const express = require('express');
const auth = require('./auth');
const traeClient = require('./trae-client');
const { handleOpenAIResponse } = require('./openai-format');
const { handleAnthropicResponse } = require('./anthropic-format');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '9220', 10);
const API_KEY = process.env.API_KEY || '';
const EDITION = (process.env.TRAE_EDITION || 'cn').toLowerCase();
const MANUAL_TOKEN = process.env.TRAE_MANUAL_TOKEN || '';
const BASE_URL = EDITION === 'cn'
  ? (process.env.BASE_URL || 'https://trae-api-cn.mchost.guru')
  : (process.env.BASE_URL || 'https://a0ai-api-sg.byteintlapi.com');

// Auth middleware
function requireAuth(req, res, next) {
  if (!API_KEY) return next();

  // Support both Authorization: Bearer <key> and x-api-key: <key>
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const xApiKey = req.headers['x-api-key'] || '';
  const token = bearerToken || xApiKey;

  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

// CORS + Request logging
app.use((req, res, next) => {
  console.log(`[server] ${req.method} ${req.path}`);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Status
app.get('/v1/status', requireAuth, (req, res) => {
  res.json({
    status: 'ok',
    edition: EDITION,
    base_url: BASE_URL,
    has_token: !!auth.getToken(),
    port: PORT,
  });
});

// Models
app.get('/v1/models', requireAuth, async (req, res) => {
  try {
    const models = await traeClient.getModels(BASE_URL);
    res.json({ object: 'list', data: models });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

// OpenAI chat completions
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  const { messages, model = 'auto', stream = false } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request' } });
  }

  console.log(`[server] Chat request: model=${model}, stream=${stream}, messages=${messages.length}`);
  console.log(`[server] Request body: ${JSON.stringify(req.body).substring(0, 500)}`);

  try {
    const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
      messages, model, stream, BASE_URL
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sseStream = await handleOpenAIResponse(fetchResp, usedModel, true);
      for await (const chunk of sseStream) {
        res.write(chunk);
      }
      res.end();
    } else {
      const result = await handleOpenAIResponse(fetchResp, usedModel, false);
      res.json(result);
    }
  } catch (err) {
    console.error(`[server] Chat error: ${err.message}`);
    res.status(502).json({
      error: {
        message: `Trae API error: ${err.message}`,
        type: 'upstream_error',
      },
    });
  }
});

// Anthropic messages
app.post('/v1/messages', requireAuth, async (req, res) => {
  console.log(`[server] Anthropic request body: ${JSON.stringify(req.body).substring(0, 800)}`);

  const { messages, model = 'auto', stream = false, max_tokens = 4096, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request' } });
  }

  // Convert Anthropic messages to OpenAI format
  const openaiMessages = [];

  // Add system message if present
  if (system) {
    const sysContent = typeof system === 'string' ? system :
      Array.isArray(system) ? system.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
    if (sysContent) {
      openaiMessages.push({ role: 'system', content: sysContent });
    }
  }

  for (const m of messages) {
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // Handle content blocks (text, tool_use, tool_result, etc.)
      const textParts = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          textParts.push(`[Tool: ${block.name}] ${JSON.stringify(block.input)}`);
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string' ? block.content :
            Array.isArray(block.content) ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          textParts.push(resultContent);
        }
      }
      content = textParts.join('\n');
    }
    if (content) {
      openaiMessages.push({ role: m.role, content });
    }
  }

  console.log(`[server] Anthropic request: model=${model}, stream=${stream}`);

  try {
    const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
      openaiMessages, model, stream, BASE_URL
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sseStream = await handleAnthropicResponse(fetchResp, usedModel, true);
      for await (const chunk of sseStream) {
        res.write(chunk);
      }
      res.end();
    } else {
      const result = await handleAnthropicResponse(fetchResp, usedModel, false);
      res.json(result);
    }
  } catch (err) {
    console.error(`[server] Anthropic error: ${err.message}`);
    res.status(502).json({
      error: {
        message: `Trae API error: ${err.message}`,
        type: 'upstream_error',
      },
    });
  }
});

// Catch-all for unknown routes
app.use((req, res) => {
  console.log(`[server] Unknown route: ${req.method} ${req.path}`);
  res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, type: 'not_found' } });
});

// Start server
function start() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Trae Local API Server v1.0.0       ║');
  console.log('║   Trae CN -> OpenAI/Anthropic Proxy      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  try {
    auth.initAuth(EDITION, MANUAL_TOKEN);
  } catch (err) {
    console.error(`[startup] Auth initialization failed: ${err.message}`);
    console.error('[startup] Ensure Trae IDE is installed and you are logged in');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[server] Running on http://localhost:${PORT}`);
    console.log(`[server] Edition: ${EDITION.toUpperCase()}`);
    console.log(`[server] Base URL: ${BASE_URL}`);
    console.log(`[server] API Key: ${API_KEY ? '***' : '(not set - open access)'}`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  GET  http://localhost:${PORT}/v1/status`);
    console.log(`  GET  http://localhost:${PORT}/v1/models`);
    console.log(`  POST http://localhost:${PORT}/v1/chat/completions  (OpenAI)`);
    console.log(`  POST http://localhost:${PORT}/v1/messages          (Anthropic)`);
    console.log('');
  });
}

start();
