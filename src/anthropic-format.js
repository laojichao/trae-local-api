/**
 * anthropic-format.js - Convert Trae SSE events to Anthropic-compatible format
 */

const { v4: uuidv4 } = require('uuid');

async function handleAnthropicResponse(fetchResponse, model, stream) {
  if (!stream) {
    return await collectNonStreaming(fetchResponse, model);
  }
  return streamGenerator(fetchResponse, model);
}

function makeMessageId() {
  return `msg_${uuidv4().replace(/-/g, '')}`;
}

function makeToolUseId() {
  return `toolu_${uuidv4().replace(/-/g, '')}`;
}

function normalizeStopReason(reason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  if (!reason || reason === 'stop') return 'end_turn';
  return reason;
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeToolInput(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeToolInput(parsed);
    } catch {
      return { value };
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return { value };
}

function parseToolCallPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(payload));
  } catch {
    return null;
  }

  const name = parsed.name || parsed.tool_name || parsed.function?.name;
  if (!name || typeof name !== 'string') return null;

  return {
    type: 'tool_use',
    id: parsed.id || makeToolUseId(),
    name,
    input: normalizeToolInput(
      parsed.input ?? parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments
    ),
  };
}

function textBlock(text) {
  const value = text.trim();
  return value ? { type: 'text', text: value } : null;
}

function parseAssistantContent(text) {
  if (!text) return [{ type: 'text', text: '' }];

  if (!/<tool_call>/i.test(text)) {
    const toolUse = parseToolCallPayload(text);
    if (toolUse) return [toolUse];
    return [{ type: 'text', text: text.trim() }];
  }

  const blocks = [];
  const pattern = /<tool_call>\s*([\s\S]*?)(?:\s*<\/tool_call>|$)/gi;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const before = textBlock(text.slice(cursor, match.index));
    if (before) blocks.push(before);

    const toolUse = parseToolCallPayload(match[1]);
    if (toolUse) {
      blocks.push(toolUse);
    } else {
      const raw = textBlock(match[0]);
      if (raw) blocks.push(raw);
    }

    cursor = pattern.lastIndex;
  }

  const after = textBlock(text.slice(cursor));
  if (after) blocks.push(after);

  return blocks.length > 0 ? blocks : [{ type: 'text', text: text.trim() }];
}

function hasToolUse(blocks) {
  return blocks.some(block => block.type === 'tool_use');
}

async function collectTraeText(fetchResponse) {
  const text = await fetchResponse.text();
  const lines = text.split('\n');
  let fullContent = '';
  let finishReason = null;
  let currentEvent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.substring(6).trim();
    } else if (trimmed.startsWith('data:')) {
      const data = trimmed.substring(5).trim();
      try {
        const parsed = JSON.parse(data);
        if (!currentEvent || currentEvent === 'output') {
          if (parsed.response) fullContent += parsed.response;
        }
        if (parsed.finish_reason) finishReason = parsed.finish_reason;
      } catch {}
    }
  }

  return { fullContent, finishReason };
}

async function collectNonStreaming(fetchResponse, model) {
  const { fullContent, finishReason } = await collectTraeText(fetchResponse);
  const content = parseAssistantContent(fullContent);
  const includesToolUse = hasToolUse(content);

  return {
    id: makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: normalizeStopReason(finishReason, includesToolUse),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function* streamGenerator(fetchResponse, model) {
  const { fullContent, finishReason } = await collectTraeText(fetchResponse);
  const content = parseAssistantContent(fullContent);
  const includesToolUse = hasToolUse(content);
  const msgId = makeMessageId();

  // message_start
  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`;

  for (let index = 0; index < content.length; index++) {
    const block = content[index];

    if (block.type === 'text') {
      yield `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })}\n\n`;

      if (block.text) {
        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        })}\n\n`;
      }
    } else if (block.type === 'tool_use') {
      yield `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })}\n\n`;

      const partialJson = JSON.stringify(block.input || {});
      yield `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      })}\n\n`;
    }

    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index,
    })}\n\n`;
  }

  yield `event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: {
      stop_reason: normalizeStopReason(finishReason, includesToolUse),
      stop_sequence: null,
    },
    usage: { output_tokens: 0 },
  })}\n\n`;

  yield `event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop',
  })}\n\n`;
}

module.exports = {
  handleAnthropicResponse,
  parseAssistantContent,
};
