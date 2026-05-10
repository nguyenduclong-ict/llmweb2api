import type { Adapter } from '../../types/adapter';
import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  InternalMessage,
  ContentBlock,
  ToolCall,
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

function extractResponsesContent(item: any): string | ContentBlock[] {
  if (typeof item === 'string') return item;
  if (typeof item?.content === 'string') return item.content;

  const content: any[] = Array.isArray(item?.content) ? item.content : Array.isArray(item) ? item : [];
  if (content.length === 0) return '';

  const parts = content
    .map((part: any): ContentBlock | null => {
      if (typeof part === 'string') return { type: 'text', text: part };

      if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
        return { type: 'text', text: part.text ?? '' };
      }

      if (part?.type === 'input_image' || part?.type === 'image_url' || part?.type === 'image') {
        const imageUrl = part.image_url ?? part.image_url?.url ?? part.url;
        return {
          type: 'image_url',
          image_url: {
            url: typeof imageUrl === 'string' ? imageUrl : (imageUrl?.url ?? ''),
            detail: part.detail ?? imageUrl?.detail,
          },
        };
      }

      return null;
    })
    .filter((part): part is ContentBlock => part !== null);

  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function normalizeResponsesRole(role: string | undefined): InternalMessage['role'] {
  if (role === 'assistant' || role === 'tool' || role === 'user') return role;
  return 'system';
}

function responsesInputToMessages(input: any): InternalMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (!Array.isArray(input)) return [];

  return input.flatMap((item: any): InternalMessage[] => {
    if (typeof item === 'string') return [{ role: 'user', content: item }];

    if (item?.type === 'message' || item?.role) {
      return [
        {
          role: normalizeResponsesRole(item.role),
          content: extractResponsesContent(item),
        },
      ];
    }

    if (item?.type === 'function_call') {
      const toolCall: ToolCall = {
        id: item.call_id ?? item.id ?? `call_${Date.now()}`,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      return [{ role: 'assistant', content: '', tool_calls: [toolCall] }];
    }

    if (item?.type === 'function_call_output') {
      return [
        {
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        },
      ];
    }

    return [];
  });
}

function normalizeResponsesTools(tools: any): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool: any) => {
    if (tool?.type === 'function' && tool.function) return tool;
    if (tool?.type === 'function' && tool.name) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    }
    return tool;
  });
}

function formatResponsesUsage(internal: InternalResponse | InternalStreamChunk): Record<string, unknown> | undefined {
  if (!internal.usage) return undefined;

  const inTok = internal.usage.cumulativeInputTokens ?? internal.usage.inputTokens;
  const outTok = internal.usage.cumulativeOutputTokens ?? internal.usage.outputTokens;
  const usage: Record<string, unknown> = {
    input_tokens: inTok,
    output_tokens: outTok,
    total_tokens: inTok + outTok,
  };

  if ('reasoningTokens' in internal.usage && internal.usage.reasoningTokens !== undefined) {
    usage.output_tokens_details = {
      reasoning_tokens: internal.usage.reasoningTokens,
    };
  }

  return usage;
}

function formatResponsesOutput(internal: InternalResponse): unknown[] {
  if (internal.toolCalls && internal.toolCalls.length > 0) {
    return internal.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }));
  }

  const content: Record<string, unknown>[] = [];
  if (internal.reasoningContent) {
    content.push({
      type: 'reasoning_text',
      text: internal.reasoningContent,
    });
  }
  content.push({
    type: 'output_text',
    text: internal.content,
    annotations: [],
  });

  return [
    {
      id: `msg_${internal.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content,
    },
  ];
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function countImageBlocks(messages: InternalMessage[]): number {
  return messages.reduce((sum, msg) => {
    if (!Array.isArray(msg.content)) return sum;
    return sum + msg.content.filter((part) => part.type === 'image_url' && !!part.image_url.url).length;
  }, 0);
}

function countUnsupportedImageErrors(messages: InternalMessage[]): number {
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

export const openaiResponsesAdapter: Adapter & {
  formatStreamStart(responseId: string, model: string): string;
  formatStreamChunk(chunk: InternalStreamChunk, responseId?: string): string;
  formatStreamDone(
    responseId: string,
    model: string,
    outputText: string,
    chunk?: InternalStreamChunk,
    toolCalls?: ToolCall[],
  ): string;
} = {
  name: 'openai-responses',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.model ?? 'gpt-3.5-turbo';
    const resolved = resolveModel('openai', vendorModel, {
      thinking: resolveThinking(body),
    });

    const messages = responsesInputToMessages(body.input ?? body.messages);
    if (typeof body.instructions === 'string' && body.instructions.length > 0) {
      messages.unshift({ role: 'system', content: body.instructions });
    }
    const conversationId =
      body.conversation_id ??
      body.previous_response_id ??
      (typeof body.conversation === 'string' ? body.conversation : body.conversation?.id);

    console.log(
      `[ADAPTER] responses request: convId=${conversationId || '<none>'} stream=${body.stream} ` +
        `tools=${Array.isArray(body.tools) ? body.tools.length : 0} msgs=${messages.length} ` +
        `images=${countImageBlocks(messages)} unsupportedImageErrors=${countUnsupportedImageErrors(messages)}`,
    );

    return {
      model: resolved.responseModel,
      providerModel: resolved.providerModel,
      providerName: resolved.providerName,
      messages,
      stream: body.stream ?? false,
      maxTokens: body.max_output_tokens ?? body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop,
      tools: normalizeResponsesTools(body.tools),
      toolChoice: body.tool_choice,
      reasoningEffort: resolved.thinking ? 'high' : undefined,
      conversationId,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const output = formatResponsesOutput(internal);
    const result: Record<string, unknown> = {
      id: `resp_${internal.id}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: internal.model,
      output,
      output_text: internal.toolCalls?.length ? '' : internal.content,
      usage: formatResponsesUsage(internal),
    };

    if (internal.conversationId) {
      result.conversation_id = internal.conversationId;
    }

    return result;
  },

  formatStreamStart(responseId: string, model: string): string {
    const response = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      model,
      output: [],
      output_text: '',
    };

    return (
      sseEvent('response.created', { type: 'response.created', response }) +
      sseEvent('response.in_progress', { type: 'response.in_progress', response }) +
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: `msg_${responseId}`,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      }) +
      sseEvent('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    );
  },

  formatStreamChunk(chunk: InternalStreamChunk, responseId?: string): string {
    if (chunk.reasoningContent) {
      return sseEvent('response.reasoning_text.delta', {
        type: 'response.reasoning_text.delta',
        delta: chunk.reasoningContent,
      });
    }

    if (chunk.toolCallDelta || chunk.toolCalls) {
      return '';
    }

    if (!chunk.content) return '';

    return sseEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: responseId ? `msg_${responseId}` : `msg_resp_${chunk.id}`,
      output_index: 0,
      content_index: 0,
      delta: chunk.content,
    });
  },

  formatStreamDone(
    responseId: string,
    model: string,
    outputText: string,
    chunk?: InternalStreamChunk,
    toolCalls?: ToolCall[],
  ): string {
    if (toolCalls && toolCalls.length > 0) {
      const output = toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }));

      const response: Record<string, unknown> = {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model,
        output,
        output_text: '',
      };

      const usage = chunk ? formatResponsesUsage(chunk) : undefined;
      if (usage) response.usage = usage;
      if (chunk?.conversationId) response.conversation_id = chunk.conversationId;

      return (
        output
          .map((item, outputIndex) =>
            sseEvent('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: outputIndex,
              item,
            }),
          )
          .join('') +
        sseEvent('response.completed', {
          type: 'response.completed',
          response,
        })
      );
    }

    const response: Record<string, unknown> = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [
        {
          id: `msg_${responseId}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText, annotations: [] }],
        },
      ],
      output_text: outputText,
    };

    const usage = chunk ? formatResponsesUsage(chunk) : undefined;
    if (usage) response.usage = usage;
    if (chunk?.conversationId) response.conversation_id = chunk.conversationId;

    return (
      sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        text: outputText,
      }) +
      sseEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: outputText, annotations: [] },
      }) +
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: (response.output as unknown[])[0],
      }) +
      sseEvent('response.completed', {
        type: 'response.completed',
        response,
      })
    );
  },
};
