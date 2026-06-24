/**
 * openai-format.js - Convert Trae SSE events to OpenAI-compatible format
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Parse Trae SSE response stream and convert to OpenAI format
 * @param {Response} fetchResponse - Fetch response with SSE body
 * @param {string} model - Model name
 * @param {boolean} stream - Whether to stream
 * @returns {object|Generator} OpenAI formatted response
 */
async function handleOpenAIResponse(fetchResponse, model, stream) {
  if (!stream) {
    return await collectNonStreaming(fetchResponse, model);
  }
  return streamGenerator(fetchResponse, model);
}

/**
 * Collect full response for non-streaming mode
 */
async function collectNonStreaming(fetchResponse, model) {
  const text = await fetchResponse.text();
  const events = parseSSE(text);

  let fullContent = '';
  let finishReason = 'stop';
  let reasoningContent = '';
  let thinkStarted = false;

  for (const { event, data } of events) {
    if (event === 'output') {
      const parsed = safeJSON(data);
      if (parsed) {
        if (parsed.reasoning_content) {
          reasoningContent += parsed.reasoning_content;
        }
        if (parsed.response) {
          fullContent += parsed.response;
        }
        if (parsed.finish_reason) {
          finishReason = parsed.finish_reason;
        }
      }
    } else if (event === 'done') {
      const parsed = safeJSON(data);
      if (parsed && parsed.finish_reason) {
        finishReason = parsed.finish_reason;
      }
    }
  }

  // Include thinking in content if present
  let content = '';
  if (reasoningContent) {
    content += `<think>\n${reasoningContent}\n</think>\n\n`;
  }
  content += fullContent;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Generator for streaming mode - yields SSE data lines
 */
async function* streamGenerator(fetchResponse, model) {
  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let buffer = '';
  let thinkStarted = false;
  let thinkEnded = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.substring(6).trim();
        continue;
      }

      if (trimmed.startsWith('data:') && currentEvent) {
        const data = trimmed.substring(5).trim();
        const chunks = processSSEEvent(currentEvent, data, model, {
          thinkStarted, thinkEnded,
        });

        for (const chunk of chunks) {
          // Update think state
          if (chunk._thinkState) {
            thinkStarted = chunk._thinkState.started;
            thinkEnded = chunk._thinkState.ended;
            delete chunk._thinkState;
          }
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        }

        // If done event, send [DONE]
        if (currentEvent === 'done') {
          yield 'data: [DONE]\n\n';
          return;
        }

        currentEvent = null;
      }
    }
  }

  yield 'data: [DONE]\n\n';
}

/**
 * Process a single SSE event and return OpenAI-format chunks
 */
function processSSEEvent(event, data, model, state) {
  const chunks = [];
  const parsed = safeJSON(data);

  if (event === 'request_wait_in_queue') {
    // Convert queue info to a content chunk (clients will ignore if they don't need it)
    if (parsed) {
      const pos = parsed.position || 0;
      chunks.push({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { content: `[Queued: position ${pos}]\n` },
          finish_reason: null,
        }],
      });
    }
  } else if (event === 'output' && parsed) {
    const response = parsed.response || '';
    const reasoning = parsed.reasoning_content || '';

    if (!response && !reasoning) return chunks;

    let deltaContent = '';

    // Handle thinking tags
    if (reasoning) {
      if (!state.thinkStarted) {
        deltaContent = '<think>\n' + reasoning;
        state.thinkStarted = true;
        state.thinkEnded = false;
      } else {
        deltaContent = reasoning;
      }
    }

    if (response) {
      if (state.thinkStarted && !state.thinkEnded) {
        deltaContent = '</think>\n\n' + response;
        state.thinkStarted = false;
        state.thinkEnded = true;
      } else {
        deltaContent = response;
      }
    }

    chunks.push({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: deltaContent },
        finish_reason: null,
      }],
      _thinkState: { started: state.thinkStarted, ended: state.thinkEnded },
    });
  } else if (event === 'done' && parsed) {
    chunks.push({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: parsed.finish_reason || 'stop',
      }],
    });
  }

  return chunks;
}

function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.substring(6).trim();
    } else if (trimmed.startsWith('data:') && currentEvent) {
      events.push({
        event: currentEvent,
        data: trimmed.substring(5).trim(),
      });
      currentEvent = null;
    }
  }

  return events;
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = { handleOpenAIResponse };
