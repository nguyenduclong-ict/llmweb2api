import type { Adapter } from '../../types/adapter';
import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  InternalMessage,
  ContentBlock,
} from '../../types/common';
import { resolveModel } from '../../app/services/modelService';

// thinking toggle priority:
//   1. thinking: { type: "enabled" | "disabled" }  → explicit on/off
//   2. reasoning_effort: "low" | "medium" | "high"  → thinking ON
//   3. neither                                       → use model default (undefined)
function resolveThinking(body: any): boolean | undefined {
  const thinkingType = body?.thinking?.type as string | undefined;
  if (thinkingType === 'enabled') return true;
  if (thinkingType === 'disabled') return false;

  const effort = body?.reasoning_effort as string | undefined;
  if (effort === 'low' || effort === 'medium' || effort === 'high') return true;

  return undefined;
}

function extractContent(message: any): string | ContentBlock[] {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => {
      if (part.type === 'image_url') {
        return {
          type: 'image_url' as const,
          image_url: {
            url: typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url ?? ''),
            detail: part.image_url?.detail,
          },
        };
      }
      return { type: 'text' as const, text: part.text ?? '' };
    });
  }
  return '';
}

export const openaiAdapter: Adapter = {
  name: 'openai',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.model ?? 'gpt-3.5-turbo';
    const resolved = resolveModel('openai', vendorModel, {
      thinking: resolveThinking(body),
    });

    let conversationId = body.conversation_id;

    const messages: InternalMessage[] = (body.messages ?? []).map((m: any) => {
      if (!conversationId && m.conversation_id) {
        conversationId = m.conversation_id;
      }

      if (!conversationId && m.reasoning_content?.startsWith('#conversation_id:')) {
        conversationId = m.reasoning_content.match(/#conversation_id:([a-zA-Z0-9-_]+)\n/)?.[1];
      }

      return {
        role: m.role ?? 'user',
        content: extractContent(m),
        name: m.name,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
      };
    });

    if (conversationId !== body.conversation_id) {
      console.log(
        `[ADAPTER] Detected conversationId=${conversationId} from ${body.conversation_id ? 'body' : 'message field'}`,
      );
    }

    console.log('[ADAPTER] tools:', body.tools ? `${body.tools.length} tools` : 'none', 'stream:', body.stream);

    return {
      model: resolved.responseModel,
      providerModel: resolved.providerModel,
      messages,
      stream: body.stream ?? false,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop,
      tools: body.tools,
      toolChoice: body.tool_choice,
      reasoningEffort: resolved.thinking ? 'high' : undefined,
      conversationId,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const message: Record<string, unknown> = { role: 'assistant' };

    if (internal.reasoningContent) {
      message.reasoning_content = internal.reasoningContent;
    }

    if (internal.toolCalls && internal.toolCalls.length > 0) {
      message.tool_calls = internal.toolCalls;
      message.content = null;
    } else {
      message.content = internal.content;
    }

    const inTok = internal.usage.cumulativeInputTokens ?? internal.usage.inputTokens;
    const outTok = internal.usage.cumulativeOutputTokens ?? internal.usage.outputTokens;
    const usage: Record<string, unknown> = {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok,
    };

    if (internal.usage.reasoningTokens !== undefined) {
      usage.completion_tokens_details = {
        reasoning_tokens: internal.usage.reasoningTokens,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      };
    }

    const result: Record<string, unknown> = {
      id: `chatcmpl-${internal.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: internal.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: internal.toolCalls?.length ? 'tool_calls' : internal.finishReason,
        },
      ],
      usage,
    };

    if (internal.conversationId) {
      result.conversation_id = internal.conversationId;
    }

    return result;
  },

  formatStreamChunk(chunk: InternalStreamChunk): string {
    const delta: Record<string, unknown> = {};

    if (chunk.toolCallDelta) {
      if (chunk.toolCallDelta.id) {
        delta.role = 'assistant';
        delta.content = null;
      }
      delta.tool_calls = [chunk.toolCallDelta];
    } else if (chunk.toolCalls) {
      delta.role = 'assistant';
      delta.content = null;
      delta.tool_calls = chunk.toolCalls;
    } else {
      if (chunk.content) delta.content = chunk.content;
      if (chunk.reasoningContent) delta.reasoning_content = chunk.reasoningContent;
    }

    const choice: Record<string, unknown> = {
      index: 0,
      delta,
      finish_reason: chunk.finishReason,
    };

    const data: Record<string, unknown> = {
      id: `chatcmpl-${chunk.id}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.model,
      choices: [choice],
    };

    if (chunk.usage) {
      const inTok = chunk.usage.cumulativeInputTokens ?? chunk.usage.inputTokens;
      const outTok = chunk.usage.cumulativeOutputTokens ?? chunk.usage.outputTokens;
      data.usage = {
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: inTok + outTok,
      };
    }

    return `data: ${JSON.stringify(data)}\n\n`;
  },
};
