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
const { handleAnthropicResponse, estimateTokens } = require('./anthropic-format');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ============================================================
// Anthropic 规范错误响应工具
// ============================================================

/**
 * 构造符合 Anthropic 规范的错误响应体
 * 格式: { type: "error", error: { type, message } }
 */
function buildAnthropicError(type, message) {
    return { type: 'error', error: { type, message } };
}

/**
 * 上游 HTTP 状态码 → Anthropic 规范状态码 + 错误类型映射
 */
function mapUpstreamStatus(status) {
    if (status === 401 || status === 403) return { status: 401, type: 'authentication_error' };
    if (status === 404) return { status: 404, type: 'not_found_error' };
    if (status === 400) return { status: 400, type: 'invalid_request_error' };
    if (status === 429) return { status: 429, type: 'rate_limit_error' };
    if (status === 529) return { status: 529, type: 'overloaded_error' };
    return { status: 502, type: 'api_error' };
}

/**
 * 发送 Anthropic 规范错误响应
 */
function sendAnthropicError(res, httpStatus, errorType, message) {
    return res.status(httpStatus).json(buildAnthropicError(errorType, message));
}

const PORT = parseInt(process.env.PORT || '9220', 10);
const API_KEY = process.env.API_KEY || '';
const EDITION = (process.env.TRAE_EDITION || 'cn').toLowerCase();
const MANUAL_TOKEN = process.env.TRAE_MANUAL_TOKEN || '';

// BASE_URL 选择:
//   cn       → Trae CN 国内版 chat API 端点
//   solo     → TRAE SOLO CN 国内独立部署版(共用 CN 端点)
//   sg       → Trae 国际版 chat API 端点
//   solo-sg  → TRAE SOLO 国际独立部署版(共用 SG 端点)
// 加密格式:cn/solo/solo-sg 使用 tc 加密;sg 使用 plaintext JSON
// chat API:cn/solo 共用 mchost.guru;sg/solo-sg 共用 byteintlapi.com
const DEFAULT_BASE_URLS = {
  cn: 'https://trae-api-cn.mchost.guru',
  solo: 'https://trae-api-cn.mchost.guru',
  sg: 'https://a0ai-api-sg.byteintlapi.com',
  'solo-sg': 'https://a0ai-api-sg.byteintlapi.com',
};
const BASE_URL = process.env.BASE_URL || DEFAULT_BASE_URLS[EDITION] || DEFAULT_BASE_URLS.cn;

// Auth middleware
function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const xApiKey = req.headers['x-api-key'] || '';
  const token = bearerToken || xApiKey;
  if (token !== API_KEY) {
    return sendAnthropicError(res, 401, 'authentication_error', 'Invalid API key');
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
    return sendAnthropicError(res, 500, 'api_error', err.message);
  }
});

// ============================================================
// Content extraction helpers
// ============================================================

function extractTextFromBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'image') parts.push('[Image]');
  }
  return parts.join('\n');
}

function extractToolResultText(block) {
  if (typeof block.content === 'string') return block.content || '(empty)';
  if (Array.isArray(block.content)) {
    const parts = [];
    for (const c of block.content) {
      if (c.type === 'text' && c.text) parts.push(c.text);
      else if (c.type === 'image') parts.push('[Image]');
    }
    return parts.join('\n') || '(empty)';
  }
  return '(empty)';
}

// ============================================================
// Content cleaning — strip ALL Claude Code internal markers
// ============================================================

const CLEAN_PATTERNS = [
  // XML-style tags (handle both closed and unclosed)
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<system-reminder>[\s\S]*?(?=<\/[a-z]|$)/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-caveat>[\s\S]*?(?=<\/[a-z]|$)/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<\/?session>/g,
  // Bracket-style markers
  /\[SUGGESTION MODE:[\s\S]*?\]/g,
  // Tool definition blocks from system prompts
  /The following deferred tools are now available[\s\S]*?(?:\n\n\n|\n(?=[A-Z#]))/g,
  /## Available Tools[\s\S]*?(?=\n## [A-Z]|\n# [A-Z]|\n---|\n\*\*)/g,
];

function cleanContent(text) {
  if (!text) return '';
  for (const pattern of CLEAN_PATTERNS) {
    text = text.replace(pattern, '');
  }
  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// ============================================================
// Tool definition → system prompt text
// ============================================================

function toolsToSystemPrompt(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const lines = ['You have access to the following tools. To use a tool, output EXACTLY this format:', '',
    '<tool_call>', '{"name": "tool_name", "arguments": {"param": "value"}}', '</tool_call>', '',
    'Available tools:'];

  for (const tool of tools) {
    const name = tool.name || tool.function?.name || 'unknown';
    const desc = tool.description || tool.function?.description || '';
    lines.push(`\n### ${name}`);
    if (desc) lines.push(desc);
    const params = tool.input_schema || tool.parameters || tool.function?.parameters;
    if (params && params.properties) {
      lines.push('Parameters:');
      for (const [key, val] of Object.entries(params.properties)) {
        const required = params.required?.includes(key) ? ' (required)' : '';
        lines.push(`- ${key}: ${val.type || 'any'}${required} - ${val.description || ''}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// Anthropic message conversion
// ============================================================

function convertAnthropicMessages(messages, systemPrompt, tools) {
  const systemParts = [];

  // System prompt
  if (systemPrompt) {
    const sysContent = typeof systemPrompt === 'string' ? systemPrompt :
      Array.isArray(systemPrompt) ? extractTextFromBlocks(systemPrompt) : '';
    const cleaned = cleanContent(sysContent);
    if (cleaned) systemParts.push(cleaned);
  }

  // Tool definitions → system prompt
  const toolPrompt = toolsToSystemPrompt(tools);
  if (toolPrompt) systemParts.push(toolPrompt);

  // Collect system-role messages from the array
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? extractTextFromBlocks(m.content) : '';
      const cleaned = cleanContent(text);
      if (cleaned) systemParts.push(cleaned);
    }
  }

  // Build result: ONE system message + non-system messages
  const result = [];
  if (systemParts.length > 0) {
    result.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  // Process non-system messages
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'system') { i++; continue; }

    // String content
    if (typeof m.content === 'string') {
      const cleaned = cleanContent(m.content);
      if (cleaned) result.push({ role: m.role, content: cleaned });
      i++; continue;
    }

    if (!Array.isArray(m.content)) { i++; continue; }

    // Assistant message
    if (m.role === 'assistant') {
      const textPart = extractTextFromBlocks(m.content);
      const toolUses = m.content.filter(b => b.type === 'tool_use');

      // No tool calls — plain text
      if (toolUses.length === 0) {
        if (textPart.trim()) result.push({ role: 'assistant', content: textPart });
        i++; continue;
      }

      // Has tool calls — merge with next user's tool_result
      let combinedText = textPart || '';

      if (i + 1 < messages.length && messages[i + 1].role === 'user') {
        const nextBlocks = Array.isArray(messages[i + 1].content) ? messages[i + 1].content : [];
        const toolResults = nextBlocks.filter(b => b.type === 'tool_result');
        const nextText = extractTextFromBlocks(nextBlocks);

        if (toolResults.length > 0) {
          const toolLines = toolUses.map(tu => {
            const inputStr = typeof tu.input === 'object' ? JSON.stringify(tu.input, null, 2) : String(tu.input);
            return `[Called tool: ${tu.name}]\n${inputStr}`;
          });
          const resultLines = toolResults.map(tr => {
            const prefix = tr.is_error ? '[Tool Error]' : '[Tool Result]';
            return `${prefix}\n${extractToolResultText(tr)}`;
          });

          const parts = [];
          if (combinedText.trim()) parts.push(combinedText);
          parts.push(toolLines.join('\n\n'));
          parts.push(resultLines.join('\n\n'));
          result.push({ role: 'assistant', content: parts.join('\n\n') });

          // Keep any non-tool text from the user message
          const cleanedNext = cleanContent(nextText);
          if (cleanedNext) result.push({ role: 'user', content: cleanedNext });

          i += 2; continue;
        }
      }

      // No matching tool_result — just describe the calls
      const toolLines = toolUses.map(tu => {
        const inputStr = typeof tu.input === 'object' ? JSON.stringify(tu.input, null, 2) : String(tu.input);
        return `[Called tool: ${tu.name}]\n${inputStr}`;
      });
      if (combinedText.trim()) combinedText += '\n\n';
      combinedText += toolLines.join('\n\n');
      if (combinedText.trim()) result.push({ role: 'assistant', content: combinedText });
      i++;

    } else if (m.role === 'user') {
      const textPart = extractTextFromBlocks(m.content);
      const toolResults = m.content.filter(b => b.type === 'tool_result');
      const cleanedText = cleanContent(textPart);

      if (cleanedText) {
        result.push({ role: 'user', content: cleanedText });
      } else if (toolResults.length > 0) {
        // Orphaned tool results
        const resultText = toolResults.map(tr => {
          const prefix = tr.is_error ? '[Tool Error]' : '[Tool Result]';
          return `${prefix}\n${extractToolResultText(tr)}`;
        }).join('\n\n');
        result.push({ role: 'user', content: resultText });
      }
      i++;
    } else {
      const textPart = extractTextFromBlocks(m.content);
      const cleaned = cleanContent(textPart);
      if (cleaned) result.push({ role: m.role, content: cleaned });
      i++;
    }
  }

  // Final: merge any remaining system messages into the first one
  let firstSys = -1;
  for (let j = 0; j < result.length; j++) {
    if (result[j] && result[j].role === 'system') {
      if (firstSys === -1) { firstSys = j; }
      else { result[firstSys].content += '\n\n' + result[j].content; result[j] = null; }
    }
  }

  return result.filter(Boolean);
}

// ============================================================
// OpenAI message conversion
// ============================================================

function convertOpenAIMessages(messages, tools) {
  const systemParts = [];

  // Tool definitions → system prompt
  const toolPrompt = toolsToSystemPrompt(tools);
  if (toolPrompt) systemParts.push(toolPrompt);

  // Collect system messages
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c.text || c.content || '').join('\n') : '';
      const cleaned = cleanContent(text);
      if (cleaned) systemParts.push(cleaned);
    }
  }

  const result = [];
  if (systemParts.length > 0) {
    result.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  for (const m of messages) {
    if (m.role === 'system') continue;
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map(c => c.text || c.content || '').join('\n');
    const cleaned = cleanContent(content);
    if (cleaned) result.push({ role: m.role, content: cleaned });
  }

  // Merge consecutive system messages
  let firstSys = -1;
  for (let j = 0; j < result.length; j++) {
    if (result[j] && result[j].role === 'system') {
      if (firstSys === -1) { firstSys = j; }
      else { result[firstSys].content += '\n\n' + result[j].content; result[j] = null; }
    }
  }

  return result.filter(Boolean);
}

// ============================================================
// OpenAI chat completions
// ============================================================

app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  const { messages, model = 'auto', stream = false, tools, max_tokens } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
  }

  console.log(`[server] OpenAI request: model=${model}, stream=${stream}, messages=${messages.length}, body=${JSON.stringify(req.body).length} bytes`);

  const converted = convertOpenAIMessages(messages, tools);
  console.log(`[server] Converted: ${messages.length} -> ${converted.length} messages`);

  try {
    const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
      converted, model, stream, BASE_URL, { maxTokens: max_tokens }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sseStream = await handleOpenAIResponse(fetchResp, usedModel, true);
      for await (const chunk of sseStream) { res.write(chunk); }
      res.end();
    } else {
      const result = await handleOpenAIResponse(fetchResp, usedModel, false);
      res.json(result);
    }
  } catch (err) {
    console.error(`[server] Chat error: ${err.message}`);
    const mapped = mapUpstreamStatus(err.status || 502);
    return sendAnthropicError(res, mapped.status, mapped.type, `Trae API error: ${err.message}`);
  }
});

// ============================================================
// Anthropic messages
// ============================================================

/**
 * 估算输入 token 数(粗略)
 * 遍历 system + messages + tools 的全部文本内容
 */
function estimateInputTokens(system, messages, tools) {
    let totalText = '';
    if (system) {
        if (typeof system === 'string') totalText += system;
        else if (Array.isArray(system)) {
            for (const b of system) totalText += b.text || '';
        }
    }
    if (Array.isArray(messages)) {
        for (const m of messages) {
            if (typeof m.content === 'string') totalText += m.content;
            else if (Array.isArray(m.content)) {
                for (const b of m.content) {
                    totalText += b.text || '';
                    if (b.input) totalText += JSON.stringify(b.input);
                    if (b.content) {
                        if (typeof b.content === 'string') totalText += b.content;
                        else if (Array.isArray(b.content)) {
                            for (const c of b.content) totalText += c.text || '';
                        }
                    }
                }
            }
        }
    }
    if (Array.isArray(tools)) {
        totalText += JSON.stringify(tools);
    }
    return estimateTokens(totalText);
}

/**
 * Anthropic count_tokens 端点
 * Claude Code 在发送主请求前会调用此端点估算上下文 token 数
 */
app.post('/v1/messages/count_tokens', requireAuth, (req, res) => {
    const { messages, system, tools } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
    }
    const inputTokens = estimateInputTokens(system, messages, tools);
    res.json({ input_tokens: inputTokens });
});

app.post('/v1/messages', requireAuth, async (req, res) => {
  const { messages, model = 'auto', stream = false, max_tokens = 4096, system, tools } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
  }

  const bodySize = JSON.stringify(req.body).length;
  console.log(`[server] Anthropic request: model=${model}, stream=${stream}, msgs=${messages.length}, tools=${tools?.length || 0}, body=${bodySize} bytes`);

  // Log input messages
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const types = Array.isArray(m.content) ? m.content.map(b => b.type).join('+') : typeof m.content;
    console.log(`[server]   in[${i}] role=${m.role}, types=${types}`);
  }

  // Convert to clean text messages
  const converted = convertAnthropicMessages(messages, system, tools);

  // Log output messages
  const totalSize = JSON.stringify(converted).length;
  console.log(`[server] Converted: ${messages.length} -> ${converted.length} messages, ${totalSize} bytes`);
  for (let i = 0; i < converted.length; i++) {
    const m = converted[i];
    const len = typeof m.content === 'string' ? m.content.length : 0;
    const preview = typeof m.content === 'string' ? m.content.substring(0, 80).replace(/\n/g, '\\n') : '';
    console.log(`[server]   out[${i}] role=${m.role}, len=${len}, preview=${preview}`);
  }

  // 估算输入 token 数(用于 Anthropic usage 字段)
  const inputTokens = estimateInputTokens(system, messages, tools);

  try {
    const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
      converted, model, stream, BASE_URL, { maxTokens: max_tokens }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sseStream = await handleAnthropicResponse(fetchResp, usedModel, true, inputTokens);
      for await (const chunk of sseStream) { res.write(chunk); }
      res.end();
    } else {
      const result = await handleAnthropicResponse(fetchResp, usedModel, false, inputTokens);
      res.json(result);
    }
  } catch (err) {
    console.error(`[server] Anthropic error: ${err.message}`);
    const mapped = mapUpstreamStatus(err.status || 502);
    return sendAnthropicError(res, mapped.status, mapped.type, `Trae API error: ${err.message}`);
  }
});

// Catch-all
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
