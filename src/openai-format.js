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

  // Empty-response placeholder: upstream never produced content but
  // signaled done. Without this, callers (e.g. omniroute / Codex) see
  // content:null and treat the response as vacuous.
  if (!fullContent && !reasoningContent) {
    fullContent = '(trae upstream 返回了空响应，未产生任何内容)';
  }

  // Include thinking in content if present
  let content = '';
  if (reasoningContent) {
    content += `<think>\n${reasoningContent}\n</think>\n\n`;
  }
  content += fullContent;

  // Token estimate: prompt tokens arrive on fetchResponse (set by server.js),
  // completion tokens are estimated from output bytes (~4 chars / token).
  const promptTokens = typeof fetchResponse.__promptTokens === 'number'
    ? fetchResponse.__promptTokens
    : 0;
  const completionBytes = Buffer.byteLength(content, 'utf8');
  const completionTokens = Math.max(1, Math.ceil(completionBytes / 4));

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
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Generator for streaming mode - yields SSE data lines
 *
 * Patches vs upstream:
 *   - track usage: emit one final usage-only chunk before [DONE]
 *   - empty-content fix: if upstream yields zero content but signals "done",
 *     inject a placeholder chunk so clients (e.g. Codex) don't see "done
 *     with content=null".
 *   - latency guarding: any 'output' or 'done' event with non-empty data
 *     is forwarded; the loop only returns after [DONE] materialized or the
 *     upstream stream actually ends.
 */
async function* streamGenerator(fetchResponse, model) {
  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let buffer = '';
  let thinkStarted = false;
  let thinkEnded = false;
  let sawDone = false;
  let completionBytes = 0;
  let contentChunkCount = 0;
  // Holds choice chunks from the current event flush until we know whether
  // to inject a placeholder ahead of them (empty-stream recovery).
  let staggerBuffer = [];
  const promptTokenEstimate = typeof fetchResponse.__promptTokens === 'number'
    ? fetchResponse.__promptTokens
    : null;

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
          if (chunk._thinkState) {
            thinkStarted = chunk._thinkState.started;
            thinkEnded = chunk._thinkState.ended;
            delete chunk._thinkState;
          }
          if (chunk.choices && chunk.choices[0]) {
            const c = chunk.choices[0];
            staggerBuffer.push(chunk);
            if (c.delta && typeof c.delta.content === 'string') {
              completionBytes += Buffer.byteLength(c.delta.content, 'utf8');
              contentChunkCount += 1;
            }
            if (c.finish_reason) {
              sawDone = true;
            }
          } else {
            // Pure-usage or non-choice chunk, yield directly.
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          }
        }

        if (currentEvent === 'done') {
          // Empty-stream recovery: inject the placeholder BEFORE the buffered
          // finish_reason chunk, so clients see real content arriving first
          // (rather than receiving `content:null, finish_reason:stop`).
          if (contentChunkCount === 0) {
            const placeholder = '(trae upstream 返回了空响应，未产生任何内容)';
            completionBytes += Buffer.byteLength(placeholder, 'utf8');
            contentChunkCount += 1;
            yield `data: ${JSON.stringify({
              id: `chatcmpl-${uuidv4()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { content: placeholder },
                finish_reason: null,
              }],
            })}\n\n`;
          }

          // Flush staggered choice chunks (typically holds the done
          // event's `delta:{} + finish_reason:stop` chunk).
          for (const buffered of staggerBuffer) {
            yield `data: ${JSON.stringify(buffered)}\n\n`;
          }
          staggerBuffer = [];

          // Emit a single usage-only final chunk before [DONE] so OpenAI
          // clients get real token counts.
          const completionTokens = Math.max(
            1, Math.ceil(completionBytes / 4)
          );
          const usageChunk = {
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: promptTokenEstimate || 0,
              completion_tokens: completionTokens,
              total_tokens: (promptTokenEstimate || 0) + completionTokens,
            },
          };
          yield `data: ${JSON.stringify(usageChunk)}\n\n`;
          yield 'data: [DONE]\n\n';
          return;
        }

        // For non-done events, immediately flush any staggered chunks so
        // mid-stream content flows to the client without delay.
        for (const buffered of staggerBuffer) {
          yield `data: ${JSON.stringify(buffered)}\n\n`;
        }
        staggerBuffer = [];

        currentEvent = null;
      }
    }
  }

  // Fallback: stream ended without an 'event: done' marker. Close cleanly.
  if (!sawDone) {
    if (contentChunkCount === 0) {
      const placeholder = '(trae upstream 流异常结束，未产生任何内容)';
      completionBytes += Buffer.byteLength(placeholder, 'utf8');
      yield `data: ${JSON.stringify({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: placeholder }, finish_reason: null }],
      })}\n\n`;
    }
    const completionTokens = Math.max(1, Math.ceil(completionBytes / 4));
    yield `data: ${JSON.stringify({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokenEstimate || 0,
        completion_tokens: completionTokens,
        total_tokens: (promptTokenEstimate || 0) + completionTokens,
      },
    })}\n\n`;
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
