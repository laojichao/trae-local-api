/**
 * trae-client.js - Trae API client
 *
 * Communicates with Trae backend API with 3-level endpoint fallback:
 * 1. /api/agent/v3/llm_utils_chat (primary - lightweight chat)
 * 2. /api/ide/v1/chat (fallback 1 - standard chat)
 * 3. /api/agent/v3/create_agent_task (fallback 2 - full agent)
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');

const DEFAULT_BASE_URL_CN = 'https://trae-api-cn.mchost.guru';
const DEFAULT_BASE_URL_SG = 'https://a0ai-api-sg.byteintlapi.com';

const IDE_VERSION_CN = '3.3.67';
const IDE_VERSION_CODE_CN = '20260401';

// Model name mapping: external name -> Trae internal name
const MODEL_MAP = {
  // Claude -> GLM-5.2 (T1 flagship)
  'claude-opus-4-7': 'glm-5.2',
  'claude-opus-4-6': 'glm-5.2',
  'claude-opus-4-5': 'glm-5.2',
  'claude-sonnet-4-6': 'glm-5.2',
  'claude-sonnet-4-5': 'glm-5.2',
  'claude-sonnet-4': 'glm-5.2',
  'claude-3.5-sonnet': 'glm-5.2',
  'claude-3.7-sonnet': 'glm-5.2',
  'claude-haiku-4-5': 'glm-5.1',
  // GPT -> DeepSeek
  'gpt-4o': 'DeepSeek-V4-Pro',
  'gpt-4o-mini': 'DeepSeek-V4-Flash',
  'gpt-4.1': 'DeepSeek-V4-Pro',
  // Auto -> GLM-5.2
  'auto': 'glm-5.2',
};

// Model tiers for fallback
const MODEL_TIERS = {
  T1: ['glm-5.2'],
  T2: ['glm-5.1', 'qwen-3.7-plus', 'kimi-k2.6', 'DeepSeek-V4-Pro'],
  T3: ['glm-5', 'qwen-3.6-plus', 'minimax-m3', 'DeepSeek-V4-Flash'],
  T4: ['glm-4.7', 'kimi-k2', 'qwen3-coder', 'minimax-m2.7'],
  T5: ['glm-4.6', 'minimax-m2.1'],
};

// Reverse: find tier for a model
function getTier(model) {
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    if (models.includes(model)) return tier;
  }
  return null;
}

function hashDeviceId(machineId) {
  return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
}

function generateMachineId() {
  return crypto.randomBytes(32).toString('hex');
}

function buildHeaders(token, userId) {
  const machineId = generateMachineId();
  return {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-uid': userId || '',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-device-id': hashDeviceId(machineId),
    'x-machine-id': machineId,
    'x-ide-version': IDE_VERSION_CN,
    'x-ide-version-code': IDE_VERSION_CODE_CN,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
}

function mapModel(requestedModel) {
  const mapped = MODEL_MAP[requestedModel];
  if (mapped) return mapped;
  // If not in map, pass through as-is
  return requestedModel;
}

/**
 * Build Trae chat request body
 */
function buildChatBody(messages, model, stream) {
  return {
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    })),
    model: model,
    function: 'inline_chat',
    stream: stream !== false,
  };
}

/**
 * Send chat request with 3-level endpoint fallback
 * Returns a readable stream of SSE events
 */
async function sendChatRequest(messages, model, stream, baseUrl) {
  const token = auth.getToken();
  const userId = auth.getUserId();

  if (!token) {
    throw new Error('No auth token available');
  }

  // Check if token needs refresh
  if (auth.needsRefresh()) {
    await auth.refreshToken();
  }

  const traeModel = mapModel(model);
  const body = buildChatBody(messages, traeModel, stream);
  const headers = buildHeaders(auth.getToken(), userId);

  // 3-level endpoint fallback
  const endpoints = [
    '/api/agent/v3/llm_utils_chat',
    '/api/ide/v1/chat',
    '/api/agent/v3/create_agent_task',
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;
    console.log(`[trae-client] Trying endpoint: ${endpoint} (model: ${traeModel})`);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        console.log(`[trae-client] Success with endpoint: ${endpoint}`);
        return { response: resp, model: traeModel, endpoint };
      }

      const text = await resp.text();
      console.warn(`[trae-client] Endpoint ${endpoint} returned ${resp.status}: ${text.substring(0, 500)}`);
      console.warn(`[trae-client] Request body was: ${JSON.stringify(body).substring(0, 500)}`);
      lastError = new Error(`${endpoint}: ${resp.status} ${text.substring(0, 500)}`);
    } catch (err) {
      console.warn(`[trae-client] Endpoint ${endpoint} error: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All endpoints failed');
}

/**
 * Get available models from Trae
 */
async function getModels(baseUrl) {
  const token = auth.getToken();
  const userId = auth.getUserId();
  const headers = buildHeaders(token, userId);

  // Return a static list based on known models
  const allModels = [];
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    for (const m of models) {
      if (!allModels.find(x => x.id === m)) {
        allModels.push({
          id: m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'trae',
          tier: tier,
        });
      }
    }
  }

  return allModels;
}

module.exports = {
  sendChatRequest,
  getModels,
  mapModel,
  MODEL_MAP,
  MODEL_TIERS,
};
