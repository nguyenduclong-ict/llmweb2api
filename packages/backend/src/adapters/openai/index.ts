import type { Adapter } from '../../types/adapter';
import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  InternalMessage,
  ContentBlock,
  ThinkingLevel,
} from '../../types/common';
import { resolveModel } from '../../app/services/modelService';

export function resolveThinking(body: any): { thinking?: boolean; thinkingLevel?: ThinkingLevel } {
  const thinkingType = body?.thinking?.type as string | undefined;
  if (thinkingType === 'disabled') return { thinking: false };

  if (thinkingType === 'enabled') {
    const effort = body?.reasoning_effort as string | undefined;
    if (effort === 'low') return { thinking: true, thinkingLevel: 'Fast' };
    if (effort === 'medium' || effort === 'high') return { thinking: true, thinkingLevel: 'Thinking' };
    return { thinking: true, thinkingLevel: 'Auto' };
  }

  const effort = body?.reasoning_effort as string | undefined;
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return { thinking: true, thinkingLevel: 'Auto' };
  }

  return {};
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

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function countImageBlocks(messages: InternalMessage[]): number {
  return messages.reduce((sum, msg) => {
    if (!Array.isArray(msg.content)) return sum;
    return sum + msg.content.filter((part) => part.type === 'image_url' && !!part.image_url.url).length;
  }, 0);
}

export function countUnsupportedImageErrors(messages: InternalMessage[]): number {
  return messages.reduce((sum, msg) => {
    if (!Array.isArray(msg.content)) return sum;
    return (
      sum +
      msg.content.filter((part) => part.type === 'text' && part.text.includes('model does not support image input'))
        .length
    );
  }, 0);
}

export const openaiAdapter: Adapter = {
  name: 'openai',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.model ?? 'gpt-3.5-turbo';
    const thinkingResolved = resolveThinking(body);
    const resolved = resolveModel('openai', vendorModel, thinkingResolved.thinking, thinkingResolved.thinkingLevel);

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
    console.log(
      `[ADAPTER] request: convId=${conversationId || '<none>'} stream=${body.stream} ` +
        `tools=${body.tools ? body.tools.length : 0} msgs=${messages.length} ` +
        `images=${countImageBlocks(messages)} unsupportedImageErrors=${countUnsupportedImageErrors(messages)}`,
    );

    return {
      model: resolved.responseModel,
      providerModel: resolved.providerModel,
      providerName: resolved.providerName,
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
      thinkingLevel: resolved.thinkingLevel,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const message: Record<string, unknown> = { role: 'assistant' };

    if (internal.conversationId) {
      message.conversation_id = internal.conversationId;
    }

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
      const toolCall = { ...chunk.toolCallDelta };
      if (toolCall.id) {
        delta.role = 'assistant';
        delta.content = null;
      } else if (toolCall.function?.arguments !== undefined) {
        toolCall.id = `call_stream_${chunk.id}_${toolCall.index}`;
      }
      delta.tool_calls = [toolCall];
    } else if (chunk.toolCalls) {
      delta.role = 'assistant';
      delta.content = null;
      delta.tool_calls = chunk.toolCalls;
    } else {
      if (chunk.content) delta.content = chunk.content;
      if (chunk.reasoningContent) delta.reasoning_content = chunk.reasoningContent;
    }

    if (chunk.conversationId) {
      delta.conversation_id = chunk.conversationId;
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

    if (chunk.conversationId) {
      data.conversation_id = chunk.conversationId;
    }

    return `data: ${JSON.stringify(data)}\n\n`;
  },
};
