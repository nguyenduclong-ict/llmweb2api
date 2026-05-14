import type { Provider, SessionContext } from '../../types/provider';
import type {
  ContentBlock,
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
} from '../../types/common';
import * as client from './client';
import { ZAI_CAPTCHA_REQUIRED_CODE, ZAI_DEFAULT_CAPTCHA_VERIFY_PARAM } from './constants';
import { toZaiUpstreamModel } from './models';
import type { ZaiMessage } from './types';
import { TOOL_SYSTEM_PROMPT, buildToolPrompt, block, toolBlock } from '../core/tool_prompt';
import { ToolSieve } from '../core/tool_sieve';

type ToolDef = {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

class ZaiProvider implements Provider {
  readonly name = 'zai';
  private conversationTokens = new Map<string, { inputTokens: number; outputTokens: number }>();

  async login(settings: Record<string, unknown>): Promise<SessionContext> {
    const token = typeof settings.token === 'string' ? settings.token.trim() : '';
    if (!token) throw new Error('Z.ai requires token in settings');
    const userId = client.extractUserIdFromToken(token);
    const captchaVerifyParam =
      typeof settings.captchaVerifyParam === 'string'
        ? settings.captchaVerifyParam.trim()
        : ZAI_DEFAULT_CAPTCHA_VERIFY_PARAM;
    return { accountId: 0, token, sessionId: '', metadata: { userId, parentMessageId: null, captchaVerifyParam } };
  }

  async createSession(ctx: SessionContext): Promise<SessionContext> {
    ctx.sessionId = '';
    ctx.metadata.parentMessageId = null;
    ctx.metadata.chatCreated = false;
    if (!ctx.metadata.userId) ctx.metadata.userId = client.extractUserIdFromToken(ctx.token);
    return ctx;
  }

  async chat(ctx: SessionContext, request: InternalRequest): Promise<InternalResponse> {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage: InternalResponse['usage'] = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of this.chatStream(ctx, request)) {
      if (chunk.content) content += chunk.content;
      if (chunk.reasoningContent) reasoning += chunk.reasoningContent;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      id: `zai-${Date.now()}`,
      model: request.model,
      content,
      reasoningContent: reasoning || undefined,
      finishReason,
      usage,
    };
  }

  async *chatStream(
    ctx: SessionContext,
    request: InternalRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<InternalStreamChunk> {
    if (signal?.aborted) return;
    const streamId = `zai-${Date.now()}`;
    const model = toZaiUpstreamModel(request.providerModel || request.model);
    const userId = String(ctx.metadata.userId || client.extractUserIdFromToken(ctx.token));
    const prepared = prepareMessages(request);
    const signaturePrompt = lastUserContent(prepared.messages) || prepared.messages.map((m) => m.content).join('\n\n');

    const created = await client.createChat(ctx.token, model, signaturePrompt);
    ctx.sessionId = created.chatId;
    const messageId = created.messageId;
    ctx.metadata.parentMessageId = null;
    const parentMessageId = null;
    const requestId = client.createMessageId();
    console.log(`[ZAI] created chat=${created.chatId} firstMsg=${created.messageId}`);
    const sieve = new ToolSieve();
    let hasToolCalls = false;
    let toolCallIndex = -1;
    let currentField: string | null = null;
    let currentToolCall: { id?: string; name?: string; arguments: string } = { arguments: '' };
    let reasoning = '';
    let inputTokens = estimateTokens(prepared.serialized);
    let outputTokens = 0;
    let finalFinishReason: string | undefined;
    let answerBuffer = '';
    let thinkingBuffer = '';

    console.log(
      `[ZAI] stream chat=${ctx.sessionId} parent=${parentMessageId || '<root>'} ` +
        `msgs=${prepared.messages.length} model=${model} tools=${request.tools?.length ?? 0}`,
    );

    const captchaVerifyParam = getCaptchaVerifyParam(ctx);
    console.log('[ZAI] captchaVerifyParam source=', captchaVerifyParam ? 'configured' : '<none>');

    for await (const event of client.streamChatCompletion({
      token: ctx.token,
      userId,
      chatId: ctx.sessionId,
      requestId,
      messageId,
      parentMessageId,
      model,
      messages: prepared.messages,
      signaturePrompt,
      captchaVerifyParam: ZAI_DEFAULT_CAPTCHA_VERIFY_PARAM,
      signal,
      enableThinking: true,
      autoWebSearch: true,
    })) {
      if (signal?.aborted) return;
      if (event.error) throw new Error(formatStreamError(event.error));
      if (event.id) {
        ctx.metadata.parentMessageId = event.id;
        ctx.metadata.lastResponseMessageId = event.id;
      }
      if (event.usage?.promptTokens) inputTokens = event.usage.promptTokens;
      if (event.usage?.completionTokens) outputTokens = event.usage.completionTokens;
      if (event.done || event.phase === 'done') {
        finalFinishReason = 'stop';
        continue;
      }
      if (!event.delta) continue;

      if (event.phase === 'thinking') {
        const cleaned = cleanSearchCitationsWithBuffer(
          event.delta,
          (value) => (thinkingBuffer = value),
          thinkingBuffer,
        );
        reasoning += cleaned;
        if (cleaned) {
          yield { id: streamId, model: request.model, content: '', reasoningContent: cleaned, finishReason: null };
        }
        continue;
      }

      const cleaned = cleanSearchCitationsWithBuffer(event.delta, (value) => (answerBuffer = value), answerBuffer);
      outputTokens += estimateTokens(cleaned);
      const toolEvents = request.tools?.length
        ? sieve.processChunk(cleaned)
        : [{ type: 'content' as const, text: cleaned }];
      for (const toolEvent of toolEvents) {
        if (toolEvent.type === 'content' && toolEvent.text) {
          yield { id: streamId, model: request.model, content: toolEvent.text, finishReason: null };
        } else if (toolEvent.type === 'tool_call_start') {
          hasToolCalls = true;
          toolCallIndex++;
          currentToolCall = { arguments: '' };
        } else if (toolEvent.type === 'tool_call_field_start') {
          currentField = toolEvent.field || null;
        } else if (toolEvent.type === 'tool_call_field_delta') {
          if (currentField === 'id') currentToolCall.id = (currentToolCall.id || '') + (toolEvent.text || '');
          if (currentField === 'name') currentToolCall.name = (currentToolCall.name || '') + (toolEvent.text || '');
          if (currentField === 'arguments') {
            currentToolCall.arguments += toolEvent.text || '';
            yield {
              id: streamId,
              model: request.model,
              content: '',
              finishReason: null,
              toolCallDelta: { index: toolCallIndex, function: { arguments: toolEvent.text || '' } },
            };
          }
        } else if (toolEvent.type === 'tool_call_field_end') {
          currentField = null;
        } else if (toolEvent.type === 'tool_call_end') {
          const name = (currentToolCall.name || 'tool').trim();
          yield {
            id: streamId,
            model: request.model,
            content: '',
            finishReason: null,
            toolCallDelta: {
              index: toolCallIndex,
              id: (currentToolCall.id || `call_${streamId}_${toolCallIndex}_${name}`).trim(),
              type: 'function',
              function: { name, arguments: currentToolCall.arguments.trim() },
            },
          };
        }
      }
    }

    const flushEvents = request.tools?.length ? sieve.flush() : [];
    for (const toolEvent of flushEvents) {
      if (toolEvent.type === 'content' && toolEvent.text) {
        yield { id: streamId, model: request.model, content: toolEvent.text, finishReason: null };
      }
    }

    const cumulative = this.accumulateTokens(ctx.sessionId, inputTokens, outputTokens);
    yield {
      id: streamId,
      model: request.model,
      content: '',
      reasoningContent: reasoning || undefined,
      finishReason: hasToolCalls ? 'tool_calls' : finalFinishReason || 'stop',
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: reasoning ? estimateTokens(reasoning) : undefined,
        ...cumulative,
      },
    };
  }

  async dispose(ctx: SessionContext): Promise<void> {
    if (ctx.sessionId) {
      try {
        await client.deleteChat(ctx.token, ctx.sessionId);
        console.log(`[ZAI] deleted chat=${ctx.sessionId}`);
      } catch (err) {
        console.warn(`[ZAI] failed to delete chat ${ctx.sessionId}: ${(err as Error).message}`);
      }
    }
    this.conversationTokens.delete(ctx.sessionId);
  }

  private accumulateTokens(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
  ): { cumulativeInputTokens: number; cumulativeOutputTokens: number } {
    const prev = this.conversationTokens.get(sessionId) || { inputTokens: 0, outputTokens: 0 };
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    this.conversationTokens.set(sessionId, prev);
    console.log(
      `[ZAI] tokens session=${sessionId.slice(0, 12)} reqIn=${inputTokens} reqOut=${outputTokens} ` +
        `cumIn=${prev.inputTokens} cumOut=${prev.outputTokens}`,
    );
    return { cumulativeInputTokens: prev.inputTokens, cumulativeOutputTokens: prev.outputTokens };
  }
}

function prepareMessages(request: InternalRequest): { messages: ZaiMessage[]; serialized: string } {
  const systemContent = request.messages
    .filter((m) => m.role === 'system')
    .map(messageContent)
    .filter(Boolean)
    .join('\n\n');
  const tools = request.tools as ToolDef[] | undefined;
  const toolPrompt = tools?.length ? [TOOL_SYSTEM_PROMPT, buildToolPrompt(tools)].join('\n\n') : '';
  const systemPrefix = [systemContent, toolPrompt].filter(Boolean).join('\n\n');
  const messages: ZaiMessage[] = [];
  let systemInjected = false;

  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      messages.push({ role: 'user', content: toolBlock(message.tool_call_id || 'unknown', messageContent(message)) });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    let content = messageContent(message);
    if (role === 'user' && systemPrefix && !systemInjected) {
      content = `${block('system', systemPrefix)}\n\nUser: ${content}`;
      systemInjected = true;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      content +=
        '\n\n' +
        message.tool_calls
          .map(
            (tc) =>
              `<tool_call><name>${tc.function.name}</name><arguments>${tc.function.arguments}</arguments></tool_call>`,
          )
          .join('\n');
    }
    messages.push({ role, content });
  }

  if (!systemInjected && systemPrefix) messages.unshift({ role: 'user', content: block('system', systemPrefix) });
  if (messages.length === 0) messages.push({ role: 'user', content: '' });
  return { messages, serialized: messages.map((m) => `${m.role}:${m.content}`).join('\n\n') };
}

function messageContent(message: InternalMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(contentBlockToText).join('');
}

function contentBlockToText(blockContent: ContentBlock): string {
  if (blockContent.type === 'text') return blockContent.text;
  throw new Error('Z.ai provider does not support image or file content yet');
}

function lastUserContent(messages: ZaiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function getCaptchaVerifyParam(ctx: SessionContext): string | undefined {
  const direct = stringValue(ctx.metadata.captchaVerifyParam);
  if (direct) return direct;

  const settings =
    ctx.metadata.accountSettings && typeof ctx.metadata.accountSettings === 'object'
      ? (ctx.metadata.accountSettings as Record<string, unknown>)
      : {};
  return stringValue(settings.captchaVerifyParam) ?? ZAI_DEFAULT_CAPTCHA_VERIFY_PARAM;
}

function cleanSearchCitationsWithBuffer(text: string, setBuffer: (value: string) => void, buffer = ''): string {
  const combined = buffer + text;
  const openIndex = combined.lastIndexOf('【');
  const closeIndex = combined.lastIndexOf('】');
  let stable = combined;
  let nextBuffer = '';
  if (openIndex > closeIndex) {
    stable = combined.slice(0, openIndex);
    nextBuffer = combined.slice(openIndex);
  }
  setBuffer(nextBuffer);
  return stable.replace(/【[^】]*(?:turn|search)[^】]*】/gi, '');
}

function formatStreamError(error: string): string {
  if (error.includes(ZAI_CAPTCHA_REQUIRED_CODE)) {
    return (
      'Z.ai requires captcha verification. Current chat.z.ai config has features.enable_captcha=true, ' +
      'so requests must include captcha_verify_param from Aliyun captcha. ' +
      'Set settings.captchaVerifyParam if you have a fresh value, otherwise this provider cannot complete the request headlessly.'
    );
  }
  return `Z.ai stream error: ${error}`;
}

export const zaiProvider: Provider = new ZaiProvider();
