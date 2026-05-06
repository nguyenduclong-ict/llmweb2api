import type { Adapter } from '../../types/adapter';
import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  InternalMessage,
  ContentBlock,
} from '../../types/common';
import { resolveModel } from '../../app/services/modelService';

function claudeThinkingToFlag(thinking?: { type: string; budget_tokens?: number }): boolean | undefined {
  if (!thinking) return undefined;
  return thinking.type === 'enabled';
}

function extractAnthropicContent(content: any): string | ContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((block: any) => {
    if (block.type === 'image') {
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:${block.source?.media_type ?? 'image/jpeg'};base64,${block.source?.data ?? ''}`,
        },
      };
    }
    if (block.type === 'tool_use')
      return { type: 'text' as const, text: `[tool_use id=${block.id} name=${block.name}]` };
    if (block.type === 'tool_result')
      return {
        type: 'text' as const,
        text: `[tool_result id=${block.tool_use_id}]: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`,
      };
    return { type: 'text' as const, text: block.text ?? '' };
  });
}

export const anthropicAdapter: Adapter = {
  name: 'anthropic',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.model ?? 'claude-3-opus-20240229';
    const resolved = resolveModel('anthropic', vendorModel, {
      thinking: claudeThinkingToFlag(body.thinking),
    });

    const messages: InternalMessage[] = [];

    if (body.system) {
      const sysContent =
        typeof body.system === 'string'
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((b: any) => b.text ?? b.content ?? '').join('\n')
            : '';
      messages.push({ role: 'system', content: sysContent });
    }

    for (const m of body.messages ?? []) {
      messages.push({
        role: m.role ?? 'user',
        content: extractAnthropicContent(m.content),
      });
    }

    return {
      model: resolved.responseModel,
      providerModel: resolved.providerModel,
      messages,
      stream: body.stream ?? false,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop_sequences,
      reasoningEffort: resolved.thinking ? 'high' : undefined,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const content: Record<string, unknown>[] = [];

    if (internal.reasoningContent) {
      content.push({ type: 'thinking', thinking: internal.reasoningContent, signature: '' });
    }

    if (internal.toolCalls && internal.toolCalls.length > 0) {
      for (const tc of internal.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    } else {
      content.push({ type: 'text', text: internal.content });
    }

    const stopReason = internal.toolCalls?.length ? 'tool_use' : internal.finishReason;

    return {
      id: `msg_${internal.id}`,
      type: 'message',
      role: 'assistant',
      model: internal.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: internal.usage.inputTokens,
        output_tokens: internal.usage.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  },

  formatStreamChunk(chunk: InternalStreamChunk): string {
    const events: string[] = [];

    if (chunk.reasoningContent) {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk.reasoningContent } })}\n\n`,
      );
    }

    if (chunk.content) {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk.content } })}\n\n`,
      );
    }

    if (chunk.finishReason) {
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: chunk.finishReason, stop_sequence: null },
          usage: chunk.usage ? { output_tokens: chunk.usage.outputTokens } : { output_tokens: 0 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      );
    }

    return events.join('');
  },
};
