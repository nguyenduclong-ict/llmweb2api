import crypto from 'crypto';
import type { Provider, SessionContext } from '../../types/provider';
import type {
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  ThinkingLevel,
} from '../../types/common';
import * as client from './client';
import type { QwenFilePayload } from './types';
import { FILE_UPLOAD_THRESHOLD } from './types';
import { TOOL_SYSTEM_PROMPT, buildToolPrompt, block, toolBlock } from '../core/tool_prompt';
import { parseToolCallXML } from '../core/tool_parser';
import { ToolSieve } from '../core/tool_sieve';
import { shouldInjectTodoReminder, buildTodoReminderBlock } from '../core/todo_reminder';

interface ImageRef {
  url: string;
  isDataUrl: boolean;
  mimeType?: string;
}

type ToolDef = {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

class QwenProvider implements Provider {
  readonly name = 'qwen';
  private sentToolsHash = new Map<string, string>();
  private sentSystemPrompt = new Set<string>();
  private sentConversationId = new Set<string>();
  private conversationTokens = new Map<string, { inputTokens: number; outputTokens: number }>();

  private accumulateTokens(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
  ): {
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
  } {
    const prev = this.conversationTokens.get(sessionId) || { inputTokens: 0, outputTokens: 0 };
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    this.conversationTokens.set(sessionId, prev);
    console.log(
      `[QWEN] tokens session=${sessionId.slice(0, 12)} reqIn=${inputTokens} reqOut=${outputTokens} ` +
        `cumIn=${prev.inputTokens} cumOut=${prev.outputTokens}`,
    );
    return { cumulativeInputTokens: prev.inputTokens, cumulativeOutputTokens: prev.outputTokens };
  }

  async login(settings: Record<string, unknown>): Promise<SessionContext> {
    const token = settings.token as string;
    if (!token) throw new Error('Qwen requires token in settings');
    return { accountId: 0, token, sessionId: '', metadata: {} };
  }

  async createSession(ctx: SessionContext): Promise<SessionContext> {
    const chatId = await client.createSession(ctx.token, 'qwen3.6-plus', 't2t');
    ctx.sessionId = chatId;
    ctx.metadata.parentMessageId = null;
    return ctx;
  }

  async chat(ctx: SessionContext, request: InternalRequest): Promise<InternalResponse> {
    const { content, files } = await this.buildPromptAndFiles(ctx, request);
    const parentId = ctx.metadata.parentMessageId as string | null;
    const model = request.providerModel || request.model;
    const thinkingMode = request.thinkingLevel;

    let text = '';
    let reasoning = '';
    let sawTextDelta = false;

    for await (const line of client.streamCompletion(
      ctx.token,
      ctx.sessionId,
      model,
      parentId,
      content,
      't2t',
      files,
      undefined,
      thinkingMode,
    )) {
      const parsed = parseStreamLine(line);
      if (!parsed) continue;
      try {
        const chunk = JSON.parse(parsed);
        const created = getCreatedResponse(chunk);
        if (created) {
          ctx.metadata.parentMessageId = created.response_id;
          continue;
        }
        const delta = chunk?.choices?.[0]?.delta;
        const contentText = extractAnswerContent(chunk, delta);
        if (contentText) {
          sawTextDelta = true;
          text += contentText;
        } else if (!sawTextDelta) {
          const doneText = extractCompletedAnswerContent(chunk);
          if (doneText) text = doneText;
        }
        const thinkingText = extractThinkingContent(chunk, delta);
        if (thinkingText) reasoning = thinkingText;
      } catch {
        continue;
      }
    }

    const toolCalls = parseToolCallXML(text);
    let responseContent = text;
    let finishReason: string = 'stop';
    if (toolCalls.length > 0) {
      responseContent = '';
      finishReason = 'tool_calls';
    }

    const inputTokens = Math.ceil(content.length / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const cumulative = this.accumulateTokens(ctx.sessionId, inputTokens, outputTokens);

    if (ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId)) {
      reasoning = (reasoning || '') + `\n#conversation_id=${ctx.metadata.conversationId}`;
      this.sentConversationId.add(ctx.sessionId);
      console.log(`[QWEN] non-stream: injected #conversation_id=${ctx.metadata.conversationId} into reasoning`);
    }

    return {
      id: `qwen-${Date.now()}`,
      model: request.model,
      content: responseContent,
      reasoningContent: reasoning || undefined,
      finishReason,
      toolCalls:
        toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id || `call_${Date.now()}_${tc.name}`,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            }))
          : undefined,
      usage: { inputTokens, outputTokens, ...cumulative },
    };
  }

  async *chatStream(
    ctx: SessionContext,
    request: InternalRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<InternalStreamChunk> {
    if (signal?.aborted) return;
    const editMessageId = ctx.metadata.editMessageId as string | undefined;
    const model = request.providerModel || request.model;
    const streamId = `qwen-${Date.now()}`;

    const thinkingMode = request.thinkingLevel;

    if (editMessageId) {
      const parentId = ctx.metadata.parentMessageId as string | undefined;
      const editFiles: QwenFilePayload[] = [];
      const lastMsg = request.messages[request.messages.length - 1];
      const editContent = messageContent(lastMsg);

      let totalOutputTokens = 0;
      let hasToolCalls = false;
      let toolCallIndex = 0;
      let tcCallId = '';
      let tcName = '';
      const sieve = new ToolSieve();
      const shouldSendConvId = !!(ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId));

      if (shouldSendConvId) {
        console.log(`[QWEN] edit-stream: injecting #conversation_id=${ctx.metadata.conversationId} into reasoningContent chunk (before loop)`);
        yield {
          id: streamId,
          model: request.model,
          content: '',
          reasoningContent: `#conversation_id=${ctx.metadata.conversationId}`,
          finishReason: null,
        };
        this.sentConversationId.add(ctx.sessionId);
      }

      try {
        for await (const line of client.streamEditMessage(
          ctx.token,
          ctx.sessionId,
          model,
          parentId ?? null,
          editContent,
          editFiles,
          signal,
          thinkingMode,
        )) {
          if (signal?.aborted) return;
          const parsed = parseStreamLine(line);
          if (!parsed) continue;
          try {
            const chunk = JSON.parse(parsed);
            const streamError = getStreamError(chunk);
            if (streamError) throw new Error(streamError);
            const created = getCreatedResponse(chunk);
            if (created) {
              ctx.metadata.parentMessageId = created.response_id;
              ctx.metadata.lastResponseMessageId = created.response_id;
              continue;
            }
            const delta = chunk?.choices?.[0]?.delta;
            if (!delta && !hasResponseEvent(chunk)) continue;

            const thinkingText = extractThinkingContent(chunk, delta);
            if (thinkingText) {
              yield {
                id: streamId,
                model: request.model,
                content: '',
                reasoningContent: thinkingText,
                finishReason: null,
              };
            }

            const contentText = extractAnswerContent(chunk, delta);
            if (contentText) {
              for (const ev of sieve.processChunk(contentText)) {
                if (ev.type === 'content' && hasText(ev.text)) {
                  totalOutputTokens += Math.ceil(ev.text.length / 4);
                  yield { id: streamId, model: request.model, content: ev.text, finishReason: null };
                } else if (ev.type === 'tool_call_start') {
                  hasToolCalls = true;
                  toolCallIndex++;
                  tcCallId = '';
                  tcName = '';
                } else if (ev.type === 'tool_call_field_delta') {
                  if (ev.field === 'id') tcCallId += ev.text || '';
                  else if (ev.field === 'name') tcName += ev.text || '';
                  else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
                    totalOutputTokens += Math.ceil((ev.text || '').length / 4);
                    yield {
                      id: streamId,
                      model: request.model,
                      content: '',
                      toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
                      finishReason: null,
                    };
                  }
                } else if (ev.type === 'tool_call_field_end' && ev.field === 'name') {
                  const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
                  totalOutputTokens += Math.ceil(tcName.length / 4);
                  yield {
                    id: streamId,
                    model: request.model,
                    content: '',
                    toolCallDelta: {
                      index: toolCallIndex - 1,
                      id: callId,
                      type: 'function',
                      function: { name: tcName, arguments: '' },
                    },
                    finishReason: null,
                  };
                }
              }
            }
          } catch {
            continue;
          }
        }
      } finally {
        if (signal?.aborted && ctx.metadata.lastResponseMessageId) {
          client.stopStream(ctx.token, ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
        }
      }

      if (signal?.aborted) return;

      for (const ev of sieve.flush()) {
        if (ev.type === 'content' && hasText(ev.text)) {
          totalOutputTokens += Math.ceil(ev.text.length / 4);
          yield { id: streamId, model: request.model, content: ev.text, finishReason: null };
        } else if (ev.type === 'tool_call_start') {
          hasToolCalls = true;
          toolCallIndex++;
          tcCallId = '';
          tcName = '';
        } else if (ev.type === 'tool_call_field_delta') {
          if (ev.field === 'id') tcCallId += ev.text || '';
          else if (ev.field === 'name') tcName += ev.text || '';
          else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
            totalOutputTokens += Math.ceil((ev.text || '').length / 4);
            yield {
              id: streamId,
              model: request.model,
              content: '',
              toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
              finishReason: null,
            };
          }
        } else if (ev.type === 'tool_call_field_end' && ev.field === 'name') {
          const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
          totalOutputTokens += Math.ceil(tcName.length / 4);
          yield {
            id: streamId,
            model: request.model,
            content: '',
            toolCallDelta: {
              index: toolCallIndex - 1,
              id: callId,
              type: 'function',
              function: { name: tcName, arguments: '' },
            },
            finishReason: null,
          };
        }
      }

      const editInputTokens = Math.ceil(editContent.length / 4);
      const editCumulative = this.accumulateTokens(ctx.sessionId, editInputTokens, totalOutputTokens);
      yield {
        id: streamId,
        model: request.model,
        content: '',
        finishReason: hasToolCalls ? 'tool_calls' : 'stop',
        usage: { inputTokens: editInputTokens, outputTokens: totalOutputTokens, ...editCumulative },
      };
      return;
    }

    const { content, files } = await this.buildPromptAndFiles(ctx, request);
    if (signal?.aborted) return;

    const parentId = ctx.metadata.parentMessageId as string | null;
    let totalOutputTokens = 0;
    let hasToolCalls = false;
    let toolCallIndex = 0;
    let tcCallId = '';
    let tcName = '';
    const debugSamples: string[] = [];
    let rawLineCount = 0;
    const sieve = new ToolSieve();
    const shouldSendConvId = !!(ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId));

    if (shouldSendConvId) {
      console.log(`[QWEN] regular-stream: injecting #conversation_id=${ctx.metadata.conversationId} into reasoningContent chunk (before loop)`);
      yield {
        id: streamId,
        model: request.model,
        content: '',
        reasoningContent: `#conversation_id=${ctx.metadata.conversationId}`,
        finishReason: null,
      };
      this.sentConversationId.add(ctx.sessionId);
    }

    try {
      for await (const line of client.streamCompletion(
        ctx.token,
        ctx.sessionId,
        model,
        parentId,
        content,
        't2t',
        files,
        signal,
        thinkingMode,
      )) {
        if (signal?.aborted) return;
        rawLineCount++;
        if (debugSamples.length < 8) debugSamples.push(line.slice(0, 500));
        const parsed = parseStreamLine(line);
        if (!parsed) continue;
        try {
          const chunk = JSON.parse(parsed);
          const streamError = getStreamError(chunk);
          if (streamError) throw new Error(streamError);
          const created = getCreatedResponse(chunk);
          if (created) {
            ctx.metadata.parentMessageId = created.response_id;
            ctx.metadata.lastResponseMessageId = created.response_id;
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta;
          if (!delta && !hasResponseEvent(chunk)) continue;

          const thinkingText = extractThinkingContent(chunk, delta);
          if (thinkingText) {
            yield {
              id: streamId,
              model: request.model,
              content: '',
              reasoningContent: thinkingText,
              finishReason: null,
            };
          }

          const contentText = extractAnswerContent(chunk, delta);
          if (contentText) {
            for (const ev of sieve.processChunk(contentText)) {
              if (ev.type === 'content' && hasText(ev.text)) {
                totalOutputTokens += Math.ceil(ev.text.length / 4);
                yield { id: streamId, model: request.model, content: ev.text, finishReason: null };
              } else if (ev.type === 'tool_call_start') {
                hasToolCalls = true;
                toolCallIndex++;
                tcCallId = '';
                tcName = '';
              } else if (ev.type === 'tool_call_field_delta') {
                if (ev.field === 'id') tcCallId += ev.text || '';
                else if (ev.field === 'name') tcName += ev.text || '';
                else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
                  totalOutputTokens += Math.ceil((ev.text || '').length / 4);
                  yield {
                    id: streamId,
                    model: request.model,
                    content: '',
                    toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
                    finishReason: null,
                  };
                }
              } else if (ev.type === 'tool_call_field_end' && ev.field === 'name') {
                const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
                totalOutputTokens += Math.ceil(tcName.length / 4);
                yield {
                  id: streamId,
                  model: request.model,
                  content: '',
                  toolCallDelta: {
                    index: toolCallIndex - 1,
                    id: callId,
                    type: 'function',
                    function: { name: tcName, arguments: '' },
                  },
                  finishReason: null,
                };
              }
            }
          }
        } catch {
          continue;
        }
      }
    } finally {
      if (signal?.aborted && ctx.metadata.lastResponseMessageId) {
        client.stopStream(ctx.token, ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
      }
    }

    if (signal?.aborted) return;

    for (const ev of sieve.flush()) {
      if (ev.type === 'content' && hasText(ev.text)) {
        totalOutputTokens += Math.ceil(ev.text.length / 4);
        yield { id: streamId, model: request.model, content: ev.text, finishReason: null };
      } else if (ev.type === 'tool_call_start') {
        hasToolCalls = true;
        toolCallIndex++;
        tcCallId = '';
        tcName = '';
      } else if (ev.type === 'tool_call_field_delta') {
        if (ev.field === 'id') tcCallId += ev.text || '';
        else if (ev.field === 'name') tcName += ev.text || '';
        else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
          totalOutputTokens += Math.ceil((ev.text || '').length / 4);
          yield {
            id: streamId,
            model: request.model,
            content: '',
            toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
            finishReason: null,
          };
        }
      } else if (ev.type === 'tool_call_field_end' && ev.field === 'name') {
        const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
        totalOutputTokens += Math.ceil(tcName.length / 4);
        yield {
          id: streamId,
          model: request.model,
          content: '',
          toolCallDelta: {
            index: toolCallIndex - 1,
            id: callId,
            type: 'function',
            function: { name: tcName, arguments: '' },
          },
          finishReason: null,
        };
      }
    }

    const inputTokens = Math.ceil(content.length / 4);
    const cumulative = this.accumulateTokens(ctx.sessionId, inputTokens, totalOutputTokens);
    if (totalOutputTokens === 0 && !hasToolCalls) {
      console.warn(
        `[QWEN] Stream ended without output: rawLines=${rawLineCount} samples=${JSON.stringify(debugSamples)}`,
      );
    }
    yield {
      id: streamId,
      model: request.model,
      content: '',
      finishReason: hasToolCalls ? 'tool_calls' : 'stop',
      usage: { inputTokens, outputTokens: totalOutputTokens, ...cumulative },
    };
  }

  async dispose(ctx: SessionContext): Promise<void> {
    this.sentSystemPrompt.delete(ctx.sessionId);
    this.sentToolsHash.delete(ctx.sessionId);
    this.sentConversationId.delete(ctx.sessionId);
    this.conversationTokens.delete(ctx.sessionId);
    if (!ctx.sessionId) return;
    try {
      await client.deleteSession(ctx.token, ctx.sessionId);
    } catch {
      /* ignore */
    }
  }

  private async buildPromptAndFiles(
    ctx: SessionContext,
    request: InternalRequest,
  ): Promise<{ content: string; files: QwenFilePayload[] }> {
    const model = request.providerModel || request.model;
    const messages = request.messages;
    const tools = request.tools as ToolDef[] | undefined;
    const hasTools = !!(tools && tools.length > 0);
    const sessionId = ctx.sessionId;
    const isRestoredSession = ctx.metadata.isRestoredSession === true;

    const imageRefs = extractImageRefsAll(messages as Array<{ role: string; content: unknown }>);
    if (imageRefs.length > 0 && MODELS_WITHOUT_IMAGE.has(model)) {
      throw new Error(`Model ${model} does not support image input`);
    }

    const uploadedFiles: QwenFilePayload[] = [];
    for (const ref of imageRefs) {
      try {
        let data: Buffer;
        let mimeType: string;
        let ext: string;
        if (ref.isDataUrl && ref.mimeType) {
          const b64 = ref.url.split(',')[1];
          if (!b64) continue;
          data = Buffer.from(b64, 'base64');
          mimeType = ref.mimeType;
          ext = mimeType.split('/')[1] || 'png';
        } else {
          const resp = await fetch(ref.url);
          if (!resp.ok) {
            console.error(`[QWEN] Failed to download ${ref.url}: HTTP ${resp.status}`);
            continue;
          }
          const arrayBuf = await resp.arrayBuffer();
          data = Buffer.from(arrayBuf);
          const contentType = resp.headers.get('content-type') || 'image/png';
          mimeType = contentType.split(';')[0].trim();
          ext = mimeType.split('/')[1] || 'png';
        }
        const filename = `image_${Date.now()}_${uploadedFiles.length}.${ext}`;
        const filePayload = await client.uploadFile(ctx.token, { filename, mimeType, bytes: new Uint8Array(data) });
        uploadedFiles.push(filePayload);
      } catch (err) {
        console.error(`[QWEN] Error uploading image:`, (err as Error).message);
      }
    }

    const isNewConversation = !isRestoredSession && !this.sentSystemPrompt.has(sessionId);

    if (isRestoredSession) {
      this.sentSystemPrompt.add(sessionId);
    }

    let toolsChanged = false;
    let toolsFileContent: string | null = null;
    if (hasTools) {
      const toolsHash = crypto.createHash('md5').update(JSON.stringify(tools)).digest('hex');
      const prevHash = this.sentToolsHash.get(sessionId);
      if (isRestoredSession && prevHash === undefined) {
        this.sentToolsHash.set(sessionId, toolsHash);
      } else {
        toolsChanged = !prevHash || toolsHash !== prevHash;
        if (toolsChanged) {
          this.sentToolsHash.set(sessionId, toolsHash);
        }
      }
    }

    if (isNewConversation || toolsChanged) {
      this.sentSystemPrompt.add(sessionId);
      const parts: string[] = [TOOL_SYSTEM_PROMPT];
      if (hasTools) {
        parts.push(buildToolPrompt(tools!));
      }
      toolsFileContent = parts.join('\n\n');
    }

    const messageXml = isNewConversation
      ? messages.map((m) => renderMessageBlock(m as InternalMessage)).join('\n\n')
      : messages
          .filter((m) => m.role !== 'assistant')
          .map((m) => renderMessageBlock(m as InternalMessage))
          .join('\n\n');

    let prompt: string;

    let toolFileInstruction = '';
    if (toolsFileContent) {
      const toolFilename = `${this.name}_tools_${Date.now()}.txt`;
      const filePayload = await client.uploadFile(ctx.token, {
        filename: toolFilename,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(toolsFileContent),
      });
      uploadedFiles.push(filePayload);
      toolFileInstruction = block(
        'system',
        `Please read the attached file (${toolFilename}) to understand the context.`,
      );
    }

    const fullPrompt = [toolFileInstruction, messageXml].filter(Boolean).join('\n\n');

    // Inject todo reminder if needed (Qwen is stateful so skip on new conversation)
    let todoReminder = '';
    if (!isNewConversation) {
      const snapshot = shouldInjectTodoReminder(messages as InternalMessage[]);
      if (snapshot) {
        todoReminder = buildTodoReminderBlock(snapshot);
        console.log(`[TODO_REMINDER] Qwen: injecting todo snapshot, ${snapshot.todos.length} items`);
      }
    }

    if (fullPrompt.length >= FILE_UPLOAD_THRESHOLD) {
      console.log(
        `[QWEN] prompt size=${fullPrompt.length} >= threshold=${FILE_UPLOAD_THRESHOLD}, uploading history as file`,
      );
      const filename = `${this.name}_${Date.now()}.txt`;

      const fileContent = isNewConversation
        ? messages
            .slice(0, -1)
            .map((m) => renderMessageBlock(m as InternalMessage))
            .join('\n\n') || '(empty history)'
        : '(Previous context is maintained by the chat session. See inline messages below for the current request.)';

      const inlineXml = isNewConversation
        ? renderMessageBlock(messages[messages.length - 1] as InternalMessage)
        : messageXml;

      const filePayload = await client.uploadFile(ctx.token, {
        filename,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(fileContent),
      });
      uploadedFiles.push(filePayload);

      const fileParts = [
        toolFileInstruction,
        block('system', `Please read the attached file (${filename}) to understand the context.`),
        inlineXml,
        todoReminder,
      ];
      prompt = fileParts.filter(Boolean).join('\n\n');
    } else {
      prompt = [fullPrompt, todoReminder].filter(Boolean).join('\n\n');
    }

    return { content: prompt, files: uploadedFiles };
  }
}

function parseStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) return trimmed;
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  return data;
}

function extractThinkingContent(chunk: Record<string, unknown>, delta: Record<string, unknown> | undefined): string {
  if (chunk.type === 'response.reasoning_text.delta' && typeof chunk.delta === 'string') return chunk.delta;
  if (!delta) return '';
  if (delta.phase === 'think' && typeof delta.content === 'string') return delta.content;
  if (delta.phase !== 'thinking_summary') return '';
  const extra = delta.extra as Record<string, unknown> | undefined;
  const summaryThought = extra?.summary_thought as Record<string, unknown> | undefined;
  const content = summaryThought?.content as string[] | undefined;
  return content && content.length > 0 ? content.join('\n') : '';
}

function extractAnswerContent(chunk: Record<string, unknown>, delta: Record<string, unknown> | undefined): string {
  if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') return chunk.delta;
  if (isAnswerDelta(delta) && typeof delta?.content === 'string') return delta.content;
  return '';
}

function extractCompletedAnswerContent(chunk: Record<string, unknown>): string {
  if (chunk.type === 'response.output_text.done' && typeof chunk.text === 'string') return chunk.text;
  const response = chunk.response as Record<string, unknown> | undefined;
  const output = response?.output;
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((item) => {
      const content = (item as Record<string, unknown>).content;
      return Array.isArray(content) ? content : [];
    })
    .map((part) => {
      const item = part as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function isAnswerDelta(delta: Record<string, unknown> | undefined): boolean {
  return !delta?.phase || delta.phase === 'answer';
}

function hasResponseEvent(chunk: Record<string, unknown>): boolean {
  return typeof chunk.type === 'string' && chunk.type.startsWith('response.');
}

function getStreamError(chunk: Record<string, unknown>): string | null {
  if (chunk.success === false) {
    const data = chunk.data as Record<string, unknown> | undefined;
    return `Qwen stream error: ${String(data?.code ?? 'Bad_Request')} ${String(data?.details ?? data?.message ?? '')}`;
  }

  const error = chunk.error as Record<string, unknown> | undefined;
  if (error) {
    return `Qwen stream error: ${String(error.message ?? error.code ?? JSON.stringify(error))}`;
  }

  const type = typeof chunk.type === 'string' ? chunk.type : '';
  if (type === 'response.failed' || type === 'response.incomplete') {
    const response = chunk.response as Record<string, unknown> | undefined;
    const responseError = response?.error as Record<string, unknown> | undefined;
    const incompleteDetails = response?.incomplete_details as Record<string, unknown> | undefined;
    return `Qwen ${type}: ${String(
      responseError?.message ?? responseError?.code ?? incompleteDetails?.reason ?? JSON.stringify(chunk).slice(0, 500),
    )}`;
  }

  return null;
}

function getCreatedResponse(chunk: Record<string, unknown>): { response_id?: string } | undefined {
  return (
    (chunk.response as { created?: { response_id?: string } } | undefined)?.created ??
    (chunk['response.created'] as { response_id?: string } | undefined)
  );
}

function hasText(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

const MODELS_WITHOUT_IMAGE = new Set(['qwen3.6-max-preview']);

function renderMessageBlock(msg: InternalMessage): string {
  const text = messageContent(msg);
  if (msg.role === 'tool') {
    return toolBlock(msg.tool_call_id || 'unknown', text);
  }
  return block(msg.role, text);
}

function messageContent(msg: InternalMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: string; text: string }).text || '')
      .join('');
  }
  return '';
}

function extractImageRefsAll(messages: Array<{ role: string; content: unknown }>): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const msg of messages) {
    if (typeof msg.content !== 'object' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'image_url') {
        const imageUrl = block.image_url as Record<string, unknown> | undefined;
        const url = imageUrl?.url as string | undefined;
        if (url) {
          const isDataUrl = url.startsWith('data:');
          refs.push({
            url,
            isDataUrl,
            mimeType: isDataUrl ? url.match(/data:(.+);base64/)?.[1] || 'image/png' : undefined,
          });
        }
      }
    }
  }
  return refs;
}

export const qwenProvider: Provider = new QwenProvider();
