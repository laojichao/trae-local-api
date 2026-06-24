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

async function collectNonStreaming(fetchResponse, model) {
  const text = await fetchResponse.text();
  const lines = text.split('\n');
  let fullContent = '';
  let finishReason = 'end_turn';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:output')) {
      // next line should be data:
      continue;
    }
    if (trimmed.startsWith('data:')) {
      const data = trimmed.substring(5).trim();
      try {
        const parsed = JSON.parse(data);
        if (parsed.response) fullContent += parsed.response;
        if (parsed.finish_reason) finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
      } catch {}
    }
  }

  return {
    id: `msg_${uuidv4().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: fullContent }],
    model,
    stop_reason: finishReason,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function* streamGenerator(fetchResponse, model) {
  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const msgId = `msg_${uuidv4().replace(/-/g, '')}`;

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

  // content_block_start
  yield `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}\n\n`;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.substring(6).trim();
      } else if (trimmed.startsWith('data:') && currentEvent) {
        const data = trimmed.substring(5).trim();

        if (currentEvent === 'output') {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.response || '';
            if (text) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              })}\n\n`;
            }
          } catch {}
        } else if (currentEvent === 'done') {
          // content_block_stop
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`;

          // message_delta
          yield `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`;

          // message_stop
          yield `event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`;
          return;
        }

        currentEvent = null;
      }
    }
  }

  yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
}

module.exports = { handleAnthropicResponse };
