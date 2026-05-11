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
import { resolveThinking, countImageBlocks, countUnsupportedImageErrors, sseEvent } from './index';

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

      if (part?.type === 'input_file' || part?.type === 'file') {
        return {
          type: 'input_file',
          file_id: part.file_id,
          file_url: part.file_url,
          file_data: part.file_data,
          filename: part.filename,
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
    input_tokens_details: {
      cached_tokens: 0,
    },
    output_tokens: outTok,
    total_tokens: inTok + outTok,
  };
  usage.output_tokens_details = {
    reasoning_tokens: ('reasoningTokens' in internal.usage && internal.usage.reasoningTokens !== undefined)
      ? internal.usage.reasoningTokens
      : 0,
  };

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

  const cleanReasoning = internal.reasoningContent
    ? internal.reasoningContent.replace(/\n?#conversation_id=[a-zA-Z0-9-_]+/, '').trim()
    : '';

  const output: Record<string, unknown>[] = [];
  if (cleanReasoning) {
    output.push({
      id: `rs_${internal.id}`,
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: cleanReasoning }],
    });
  }
  output.push({
    id: `msg_${internal.id}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: internal.content, annotations: [] }],
  });

  return output;
}

export const openaiResponsesAdapter: Adapter & {
  formatStreamStart(responseId: string, model: string): string;
  formatStreamChunk(chunk: InternalStreamChunk, responseId?: string): string;
  formatStreamDone(
    responseId: string,
    model: string,
    outputText: string,
    reasoningText: string,
    chunk?: InternalStreamChunk,
    toolCalls?: ToolCall[],
    outputIndexBase?: number,
  ): string;
  formatFunctionCallArgumentsDelta(callId: string, delta: string): string;
  formatFunctionCallArgumentsDone(callId: string, argsStr: string): string;
  formatOutputItemAdded(outputIndex: number, item: Record<string, unknown>): string;
} = {
  name: 'openai-responses',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.model ?? 'gpt-3.5-turbo';
    const thinkingResolved = resolveThinking(body);
    const resolved = resolveModel('openai', vendorModel, thinkingResolved.thinking, thinkingResolved.thinkingLevel);

    const messages = responsesInputToMessages(body.input ?? body.messages);
    if (typeof body.instructions === 'string' && body.instructions.length > 0) {
      messages.unshift({ role: 'system', content: body.instructions });
    }
    const conversationId: string | undefined =
      body.conversation?.id ??
      body.conversation_id ??
      body.previous_response_id ??
      (typeof body.conversation === 'string' ? body.conversation : undefined);

    if (conversationId) {
      console.log(`[RESPONSES] parsed conversation_id=${conversationId} from request`);
    }

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
      promptCacheKey: body.prompt_cache_key,
      reasoning: body.reasoning,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const output = formatResponsesOutput(internal);
    const result: Record<string, unknown> = {
      id: `resp_${internal.id}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      store: true,
      error: null,
      incomplete_details: null,
      model: internal.model,
      output,
      output_text: internal.toolCalls?.length ? '' : internal.content,
      usage: formatResponsesUsage(internal),
    };

    if (internal.conversationId) {
      result.conversation = { id: internal.conversationId };
      console.log(`[RESPONSES] response has conversation.id=${internal.conversationId}`);
    } else {
      console.log(`[RESPONSES] response MISSING conversation.id`);
    }

    return result;
  },

  formatStreamStart(responseId: string, model: string): string {
    const response = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      store: true,
      model,
      output: [],
      output_text: '',
    };

    return (
      sseEvent('response.created', { type: 'response.created', response }) +
      sseEvent('response.in_progress', { type: 'response.in_progress', response })
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

  formatFunctionCallArgumentsDelta(callId: string, delta: string): string {
    return sseEvent('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: callId,
      delta,
    });
  },

  formatOutputItemAdded(outputIndex: number, item: Record<string, unknown>): string {
    return sseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });
  },

  formatFunctionCallArgumentsDone(callId: string, argsStr: string): string {
    return sseEvent('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: callId,
      arguments: argsStr,
    });
  },

  formatStreamDone(
    responseId: string,
    model: string,
    outputText: string,
    reasoningText: string,
    chunk?: InternalStreamChunk,
    toolCalls?: ToolCall[],
    outputIndexBase = 1,
  ): string {
    const cleanReasoning = reasoningText
      ? reasoningText.replace(/\n?#conversation_id=[a-zA-Z0-9-_]+/, '').trim()
      : '';

    if (toolCalls && toolCalls.length > 0) {
      const usage = chunk ? formatResponsesUsage(chunk) : undefined;

      const fcOutput = toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }));

      const output: Record<string, unknown>[] = [];
      if (cleanReasoning) {
        output.push({
          id: `rs_${responseId}`,
          type: 'reasoning',
          status: 'completed',
          content: [{ type: 'reasoning_text', text: cleanReasoning }],
        });
      }
      output.push(...fcOutput);

      const response: Record<string, unknown> = {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        store: true,
        model,
        output,
        output_text: '',
      };

      if (usage) response.usage = usage;
      if (chunk?.conversationId) response.conversation = { id: chunk.conversationId };

      const hasReasoning = cleanReasoning ? 1 : 0;
      return (
        fcOutput
          .map((item, i) => {
            const oi = outputIndexBase + hasReasoning + i;
            return (
              openaiResponsesAdapter.formatFunctionCallArgumentsDone(item.call_id as string, item.arguments as string) +
              sseEvent('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: oi,
                item,
              })
            );
          })
          .join('') +
        sseEvent('response.completed', {
          type: 'response.completed',
          response,
        })
      );
    }

    const output: Record<string, unknown>[] = [];
    if (cleanReasoning) {
      output.push({
        id: `rs_${responseId}`,
        type: 'reasoning',
        status: 'completed',
        content: [{ type: 'reasoning_text', text: cleanReasoning }],
      });
    }
    const msgOutput: Record<string, unknown> = {
      id: `msg_${responseId}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText, annotations: [] }],
    };
    const msgIndex = output.length;
    output.push(msgOutput);

    const response: Record<string, unknown> = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      store: true,
      model,
      output,
      output_text: outputText,
    };

    const usage = chunk ? formatResponsesUsage(chunk) : undefined;
    if (usage) response.usage = usage;
    if (chunk?.conversationId) response.conversation = { id: chunk.conversationId };

    return (
      sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: `msg_${responseId}`,
        output_index: msgIndex,
        content_index: 0,
        text: outputText,
      }) +
      sseEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: `msg_${responseId}`,
        output_index: msgIndex,
        content_index: 0,
        part: { type: 'output_text', text: outputText, annotations: [] },
      }) +
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: msgIndex,
        item: msgOutput,
      }) +
      sseEvent('response.completed', {
        type: 'response.completed',
        response,
      })
    );
  },
};
