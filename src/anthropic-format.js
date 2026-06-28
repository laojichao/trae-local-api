/**
 * anthropic-format.js - Convert Trae SSE events to Anthropic-compatible format
 *
 * 支持:
 *   - text content block
 *   - tool_use content block (从模型输出的 <tool_call>...</tool_call> 解析)
 *   - ping 事件(Anthropic 官方流式规范)
 *   - stop_reason 在工具调用时为 tool_use
 *   - token usage 估算
 */

const { v4: uuidv4 } = require('uuid');

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

/**
 * 粗略 token 估算:中文 ~1.5 token/字,ASCII ~0.25 token/字
 */
function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code > 0x2000) tokens += 1.5;
        else tokens += 0.25;
    }
    return Math.ceil(tokens);
}

/**
 * 从完整文本中提取 text 段 + tool_call 段
 * 用于非流式响应
 */
function parseToolCalls(text) {
    const result = [];
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        // 标签前的文本
        if (match.index > lastIndex) {
            const before = text.substring(lastIndex, match.index);
            if (before.trim()) result.push({ type: 'text', text: before });
        }
        // 解析 JSON
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.name) {
                result.push({
                    type: 'tool_use',
                    name: parsed.name,
                    input: parsed.arguments || parsed.input || parsed.parameters || {},
                });
            } else {
                result.push({ type: 'text', text: match[0] });
            }
        } catch (e) {
            // 解析失败,作为文本保留
            result.push({ type: 'text', text: match[0] });
        }
        lastIndex = regex.lastIndex;
    }

    // 剩余文本
    if (lastIndex < text.length) {
        const after = text.substring(lastIndex);
        if (after.trim()) result.push({ type: 'text', text: after });
    }

    return result;
}

/**
 * 流式增量解析器
 * 维护内部 buffer,每次 push 累积文本,takeBlocks 返回已完成的块
 * 处理 <tool_call>...</tool_call> 标签可能跨多个 chunk 的情况
 */
class StreamingToolCallParser {
    constructor() {
        this.buffer = '';
        this.inToolCall = false;
    }

    push(chunk) {
        this.buffer += chunk;
    }

    takeBlocks() {
        const blocks = [];

        while (true) {
            if (this.inToolCall) {
                // 寻找 </tool_call>
                const endIdx = this.buffer.indexOf(CLOSE_TAG);
                if (endIdx === -1) break; // 未闭合,等待更多数据
                const jsonStr = this.buffer.substring(0, endIdx).trim();
                this.buffer = this.buffer.substring(endIdx + CLOSE_TAG.length);
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.name) {
                        blocks.push({
                            type: 'tool_use',
                            name: parsed.name,
                            input: parsed.arguments || parsed.input || parsed.parameters || {},
                        });
                    } else {
                        blocks.push({ type: 'text', text: OPEN_TAG + jsonStr + CLOSE_TAG });
                    }
                } catch (e) {
                    blocks.push({ type: 'text', text: OPEN_TAG + jsonStr + CLOSE_TAG });
                }
                this.inToolCall = false;
            } else {
                // 寻找 <tool_call>
                const startIdx = this.buffer.indexOf(OPEN_TAG);
                if (startIdx === -1) {
                    // 检查是否有不完整的前缀(可能是 <tool_call> 的开头)
                    const lastLt = this.buffer.lastIndexOf('<');
                    if (lastLt !== -1) {
                        const tail = this.buffer.substring(lastLt);
                        if (OPEN_TAG.startsWith(tail)) {
                            // 保留可能是标签开头部分
                            if (lastLt > 0) {
                                blocks.push({ type: 'text', text: this.buffer.substring(0, lastLt) });
                            }
                            this.buffer = tail;
                            break;
                        }
                    }
                    // 全部作为文本输出
                    if (this.buffer) {
                        blocks.push({ type: 'text', text: this.buffer });
                    }
                    this.buffer = '';
                    break;
                }
                // 输出标签前的文本
                if (startIdx > 0) {
                    blocks.push({ type: 'text', text: this.buffer.substring(0, startIdx) });
                }
                this.buffer = this.buffer.substring(startIdx + OPEN_TAG.length);
                this.inToolCall = true;
            }
        }
        return blocks;
    }

    flush() {
        const blocks = [];
        if (this.inToolCall) {
            // 未闭合的 tool_call,作为文本保留
            blocks.push({ type: 'text', text: OPEN_TAG + this.buffer });
            this.buffer = '';
            this.inToolCall = false;
        } else if (this.buffer) {
            blocks.push({ type: 'text', text: this.buffer });
            this.buffer = '';
        }
        return blocks;
    }
}

/**
 * 入口:统一处理流式/非流式
 * @param {Response} fetchResponse - 上游 fetch 响应
 * @param {string} model - 模型名
 * @param {boolean} stream - 是否流式
 * @param {number} inputTokens - 输入 token 估算(可选)
 */
async function handleAnthropicResponse(fetchResponse, model, stream, inputTokens) {
    const inTokens = inputTokens || 0;
    if (!stream) {
        return await collectNonStreaming(fetchResponse, model, inTokens);
    }
    return streamGenerator(fetchResponse, model, inTokens);
}

/**
 * 非流式:收集完整响应后解析
 */
async function collectNonStreaming(fetchResponse, model, inputTokens) {
    const text = await fetchResponse.text();
    const lines = text.split('\n');
    let fullContent = '';
    let finishReason = 'end_turn';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:output')) continue;
        if (trimmed.startsWith('data:')) {
            const data = trimmed.substring(5).trim();
            try {
                const parsed = JSON.parse(data);
                if (parsed.response) fullContent += parsed.response;
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
            } catch {}
        }
    }

    // 解析 tool_call 块
    const blocks = parseToolCalls(fullContent);
    const content = [];
    let hasToolUse = false;

    for (const block of blocks) {
        if (block.type === 'text') {
            if (block.text.trim()) {
                content.push({ type: 'text', text: block.text });
            }
        } else if (block.type === 'tool_use') {
            content.push({
                type: 'tool_use',
                id: `toolu_${uuidv4().replace(/-/g, '')}`,
                name: block.name,
                input: block.input,
            });
            hasToolUse = true;
        }
    }

    // 如果没有任何内容,添加空文本
    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const outputTokens = estimateTokens(fullContent);

    return {
        id: `msg_${uuidv4().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: hasToolUse ? 'tool_use' : finishReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
}

/**
 * 流式:逐 chunk 解析并输出 Anthropic SSE 事件
 *
 * 事件序列(Anthropic 官方规范):
 *   message_start → ping → [content_block_start → content_block_delta* → content_block_stop]+
 *   → message_delta → message_stop
 */
async function* streamGenerator(fetchResponse, model, inputTokens) {
    const reader = fetchResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const msgId = `msg_${uuidv4().replace(/-/g, '')}`;
    const parser = new StreamingToolCallParser();

    // 块状态
    let blockIndex = -1;
    let currentBlockType = null; // 'text' | 'tool_use' | null
    let totalOutputText = '';
    let hasToolUse = false;
    let finishReason = 'end_turn';
    let doneReceived = false;

    // ---------- 事件构造辅助 ----------

    const messageStart = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    })}\n\n`;

    const pingEvent = `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`;

    function startTextBlock() {
        blockIndex++;
        currentBlockType = 'text';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
        })}\n\n`;
    }

    function startToolUseBlock(name, id) {
        blockIndex++;
        currentBlockType = 'tool_use';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
        })}\n\n`;
    }

    function textDelta(text) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text },
        })}\n\n`;
    }

    function inputJsonDelta(json) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: json },
        })}\n\n`;
    }

    function closeCurrentBlock() {
        if (currentBlockType === null) return '';
        const out = `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: blockIndex,
        })}\n\n`;
        currentBlockType = null;
        return out;
    }

    /**
     * 处理一批已完成的 parser 块,转换为对应 SSE 事件
     */
    function processBlocks(blocks) {
        let out = '';
        for (const block of blocks) {
            if (block.type === 'text') {
                if (!block.text) continue;
                if (currentBlockType !== 'text') {
                    out += closeCurrentBlock();
                    out += startTextBlock();
                }
                out += textDelta(block.text);
            } else if (block.type === 'tool_use') {
                // 关闭当前块(若有)
                out += closeCurrentBlock();
                // 开启 tool_use 块
                const toolId = `toolu_${uuidv4().replace(/-/g, '')}`;
                out += startToolUseBlock(block.name, toolId);
                // 输入 JSON 作为 input_json_delta
                out += inputJsonDelta(JSON.stringify(block.input));
                // 关闭 tool_use 块
                out += closeCurrentBlock();
                hasToolUse = true;
            }
        }
        return out;
    }

    // ---------- 发送 message_start + ping ----------
    yield messageStart;
    yield pingEvent;

    // ---------- 主循环 ----------
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.substring(6).trim();
                continue;
            }
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.substring(5).trim();

            // done 事件:两个版本(CN/SG)都有 event:done
            // SG 版 done 数据:{"finish_reason":"stop"}
            if (currentEvent === 'done') {
                doneReceived = true;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.finish_reason) {
                        finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                    }
                } catch {}

                // flush 残留
                const finalBlocks = parser.flush();
                const out1 = processBlocks(finalBlocks);
                if (out1) yield out1;
                // 关闭当前块
                const closeOut = closeCurrentBlock();
                if (closeOut) yield closeOut;

                // message_delta
                yield `event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: {
                        stop_reason: hasToolUse ? 'tool_use' : finishReason,
                        stop_sequence: null,
                    },
                    usage: { output_tokens: estimateTokens(totalOutputText) },
                })}\n\n`;

                // message_stop
                yield `event: message_stop\ndata: ${JSON.stringify({
                    type: 'message_stop',
                })}\n\n`;
                return;
            }

            // 其他事件:基于 JSON 内容判断(不依赖 event 类型)
            // CN 版:event:output + data:{"response":"..."}
            // SG 版:大部分 data 行无 event 前缀,event 为 null
            try {
                const parsed = JSON.parse(data);
                // 文本响应
                if (parsed.response !== undefined && parsed.response !== null) {
                    const text = parsed.response;
                    if (text) {
                        totalOutputText += text;
                        parser.push(text);
                        const blocks = parser.takeBlocks();
                        const out = processBlocks(blocks);
                        if (out) yield out;
                    }
                }
                // finish_reason(可能在任何事件中)
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
            } catch {}

            currentEvent = null;
        }
    }

    // 流自然结束(未收到 done 事件)
    if (!doneReceived) {
        const finalBlocks = parser.flush();
        const out1 = processBlocks(finalBlocks);
        if (out1) yield out1;
        const closeOut = closeCurrentBlock();
        if (closeOut) yield closeOut;

        yield `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {
                stop_reason: hasToolUse ? 'tool_use' : finishReason,
                stop_sequence: null,
            },
            usage: { output_tokens: estimateTokens(totalOutputText) },
        })}\n\n`;
        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    }
}

module.exports = { handleAnthropicResponse, parseToolCalls, estimateTokens };
