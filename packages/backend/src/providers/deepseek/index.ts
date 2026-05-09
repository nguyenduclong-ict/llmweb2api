import crypto from 'crypto';
import type { Provider, SessionContext } from '../../types/provider';
import type { InternalMessage, InternalRequest, InternalResponse, InternalStreamChunk } from '../../types/common';
import * as client from './client';
import type { DeepSeekCompletionPayload } from './types';
import { FILE_UPLOAD_THRESHOLD } from './types';
import { getModelType } from './models';
import { hashMessage } from '../core/hash';
import { TOOL_SYSTEM_PROMPT, buildToolPrompt, block, toolBlock } from '../core/tool_prompt';
import { ToolSieve } from '../core/tool_sieve';
import { parseToolCallXML } from '../core/tool_parser';

interface ImageRef {
  url: string;
  isDataUrl: boolean;
  mimeType?: string;
}

interface ImageSummary {
  messageHash: string;
  summary: string;
  imageCount: number;
}

const VISION_SYSTEM_PROMPT = `Bạn là model vision phụ trợ. Hãy phân tích các ảnh được đính kèm để hỗ trợ model chính không có vision.

Yêu cầu:
- Trả lời bằng tiếng Việt nếu người dùng dùng tiếng Việt.
- Mô tả các chi tiết quan trọng trong ảnh.
- OCR mọi chữ nhìn thấy được nếu có.
- Trả lời trực tiếp yêu cầu cuối của người dùng dựa trên ảnh.
- Không gọi công cụ.
- Không nói rằng bạn không thấy ảnh nếu ảnh đã được đính kèm.`;

type ToolDef = {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

class DeepSeekProvider implements Provider {
  readonly name = 'deepseek';
  private uploadedFileIds: string[] = [];
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
      `[TOKEN] session=${sessionId.slice(0, 12)} reqIn=${inputTokens} reqOut=${outputTokens} ` +
        `cumIn=${prev.inputTokens} cumOut=${prev.outputTokens}`,
    );
    return { cumulativeInputTokens: prev.inputTokens, cumulativeOutputTokens: prev.outputTokens };
  }

  async login(settings: Record<string, unknown>): Promise<SessionContext> {
    const email = settings.email as string;
    const password = settings.password as string;
    if (!email || !password) throw new Error('DeepSeek requires email and password');

    const token = await client.login(email, password);

    return {
      accountId: 0,
      token,
      sessionId: '',
      metadata: {},
    };
  }

  async createSession(ctx: SessionContext): Promise<SessionContext> {
    const sessionId = await client.createSession(ctx.token);
    ctx.sessionId = sessionId;
    return ctx;
  }

  async chat(ctx: SessionContext, request: InternalRequest): Promise<InternalResponse> {
    request = await this.prepareVisionRequest(ctx, request);
    const forceTools = ctx.metadata.toolsChanged === true;
    const isRestoredSession = ctx.metadata.isRestoredSession === true;
    const { prompt, refFileIds } = await this.buildPromptAndFiles(
      ctx.token,
      ctx.sessionId,
      request,
      forceTools,
      isRestoredSession,
    );
    const powResponse = await client.getPowForTarget(ctx.token, '/api/v0/chat/completion');
    const parentMessageId = ctx.metadata.parentMessageId ? Number(ctx.metadata.parentMessageId) : null;
    const modelType = getModelType(request.providerModel || request.model);
    console.log(
      `[DEEPSEEK] completion payload: sessionId=${ctx.sessionId.slice(0, 12)} ` +
        `parentMsgId=${parentMessageId} modelType=${modelType} promptLen=${prompt.length} ` +
        `refFiles=${refFileIds.length}`,
    );
    const payload: DeepSeekCompletionPayload = {
      chat_session_id: ctx.sessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      thinking_enabled: !!request.reasoningEffort,
      search_enabled: true,
      ref_file_ids: refFileIds.length > 0 ? refFileIds : [],
    };

    let text = '';
    let reasoning = '';
    let currentFragmentType: string | null = null;
    let gotMessageId = false;
    for await (const line of client.streamCompletionLines(ctx.token, powResponse, payload)) {
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const chunk = JSON.parse(raw);

        if (!gotMessageId && chunk.response_message_id != null) {
          ctx.metadata.lastResponseMessageId = String(chunk.response_message_id);
          if (chunk.request_message_id != null) {
            ctx.metadata.lastRequestMessageId = String(chunk.request_message_id);
          }
          gotMessageId = true;
          continue;
        }
        const result = parseContent(chunk, currentFragmentType);
        if (result) {
          currentFragmentType = result.nextType;
          text += result.content;
          if (result.reasoningContent) reasoning += result.reasoningContent;
        }
      } catch {
        continue;
      }
    }

    // Parse tool calls from accumulated text
    const toolCalls = parseToolCallXML(text);
    let responseContent = text;
    let finishReason: string = 'stop';
    if (toolCalls.length > 0) {
      responseContent = '';
      finishReason = 'tool_calls';
    } else if (text.includes('[#l2a:tool_call]') && toolCalls.length === 0) {
      console.error('[DEEPSEEK] Non-stream: text contains tool_call tag but parsed 0 tool calls.');
      console.error('[DEEPSEEK] Full response text:', text);
    }

    // Inject conversation_id as first reasoning line (only on first message)
    if (reasoning && ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId)) {
      reasoning = `#conversation_id:${ctx.metadata.conversationId}\n` + reasoning;
      this.sentConversationId.add(ctx.sessionId);
    }

    const inputTokens = this.estimateTokens(prompt);
    const outputTokens = this.estimateTokens(text);
    const cumulative = this.accumulateTokens(ctx.sessionId, inputTokens, outputTokens);

    return {
      id: `ds-${Date.now()}`,
      model: request.model,
      content: responseContent,
      reasoningContent: reasoning || undefined,
      finishReason,
      toolCalls: toolCalls?.map((tc) => ({
        id: tc.id || `call_${Date.now()}_${tc.name}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
      usage: { inputTokens, outputTokens, ...cumulative },
    };
  }

  async *chatStream(
    ctx: SessionContext,
    request: InternalRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<InternalStreamChunk> {
    request = await this.prepareVisionRequest(ctx, request, signal);
    const editMessageId = ctx.metadata.editMessageId as number | undefined;

    const parentMsgId = ctx.metadata.parentMessageId;
    console.log(
      `[DEEPSEEK] chatStream: editMsgId=${editMessageId ?? '<none>'} ` +
        `parentMsgId=${parentMsgId ?? '<none>'} ` +
        `msgs=${request.messages.length} roles=[${request.messages.map((m) => m.role).join(',')}]`,
    );

    // Regeneration via edit_message
    if (editMessageId) {
      const msgContent = buildEditMessagePrompt(request);
      const powResponse = await client.getPowForTarget(ctx.token, '/api/v0/chat/edit_message');
      const editPayload: client.EditMessagePayload = {
        chat_session_id: ctx.sessionId,
        message_id: editMessageId,
        prompt: msgContent,
        thinking_enabled: !!request.reasoningEffort,
        search_enabled: true,
      };

      const streamId = `ds-${Date.now()}`;
      let totalTokens = 0;
      let currentFragmentType: string | null = null;
      let firstChunk = true;
      let gotMessageId = false;
      let hasToolCalls = false;
      let toolCallIndex = 0;
      let tcCallId = '';
      let tcName = '';
      const sieve = new ToolSieve();

      try {
        for await (const line of client.streamEditMessageLines(ctx.token, powResponse, editPayload, signal)) {
          if (signal?.aborted) return;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          if (raw.indexOf('FINISHED') >= 0 && raw.indexOf('response/status') >= 0) break;

          try {
            const chunk = JSON.parse(raw);

            if (!gotMessageId && chunk.response_message_id != null) {
              ctx.metadata.lastResponseMessageId = String(chunk.response_message_id);
              if (chunk.request_message_id != null) {
                ctx.metadata.lastRequestMessageId = String(chunk.request_message_id);
              }
              gotMessageId = true;
              continue;
            }
            const result = parseContent(chunk, currentFragmentType);
            if (result) {
              currentFragmentType = result.nextType;
              if (result.content || result.reasoningContent) {
                const content = result.content;
                let reasoning = result.reasoningContent;

                if (firstChunk && ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId)) {
                  yield {
                    id: streamId,
                    model: request.model,
                    content: '',
                    reasoningContent: `#conversation_id:${ctx.metadata.conversationId}\n`,
                    finishReason: null,
                  };
                  this.sentConversationId.add(ctx.sessionId);
                }
                firstChunk = false;

                if (content) {
                  const events = sieve.processChunk(content);
                  for (const ev of events) {
                    if (ev.type === 'content' && hasText(ev.text)) {
                      totalTokens += this.estimateTokens(ev.text);
                      yield {
                        id: streamId,
                        model: request.model,
                        content: ev.text,
                        reasoningContent: reasoning || undefined,
                        finishReason: null,
                      };
                      reasoning = undefined;
                    } else if (ev.type === 'tool_call_start') {
                      hasToolCalls = true;
                      toolCallIndex++;
                      tcCallId = '';
                      tcName = '';
                    } else if (ev.type === 'tool_call_field_delta') {
                      if (ev.field === 'id') tcCallId += ev.text || '';
                      else if (ev.field === 'name') tcName += ev.text || '';
                      else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
                        totalTokens += this.estimateTokens(ev.text || '');
                        yield {
                          id: streamId,
                          model: request.model,
                          content: '',
                          toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
                          finishReason: null,
                        };
                      }
                    } else if (ev.type === 'tool_call_field_end') {
                      if (ev.field === 'name') {
                        const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
                        totalTokens += this.estimateTokens(tcName);
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
                  reasoning = undefined;
                } else if (hasText(reasoning)) {
                  yield {
                    id: streamId,
                    model: request.model,
                    content: '',
                    reasoningContent: reasoning,
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

      // Flush
      const flushEvents = sieve.flush();
      for (const ev of flushEvents) {
        if (ev.type === 'content' && hasText(ev.text)) {
          totalTokens += this.estimateTokens(ev.text);
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
            totalTokens += this.estimateTokens(ev.text || '');
            yield {
              id: streamId,
              model: request.model,
              content: '',
              toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
              finishReason: null,
            };
          }
        } else if (ev.type === 'tool_call_field_end') {
          if (ev.field === 'name') {
            const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
            totalTokens += this.estimateTokens(tcName);
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

      this.uploadedFileIds = [];

      const editInputTokens = this.estimateTokens(msgContent);
      const editCumulative = this.accumulateTokens(ctx.sessionId, editInputTokens, totalTokens);
      yield {
        id: streamId,
        model: request.model,
        content: '',
        finishReason: hasToolCalls ? 'tool_calls' : 'stop',
        usage: { inputTokens: editInputTokens, outputTokens: totalTokens, ...editCumulative },
      };
      return;
    }

    // Normal completion flow
    if (signal?.aborted) return;
    const forceTools = ctx.metadata.toolsChanged === true;
    const isRestoredSession = ctx.metadata.isRestoredSession === true;
    const { prompt, refFileIds } = await this.buildPromptAndFiles(
      ctx.token,
      ctx.sessionId,
      request,
      forceTools,
      isRestoredSession,
    );
    if (signal?.aborted) return;
    const powResponse = await client.getPowForTarget(ctx.token, '/api/v0/chat/completion');
    const parentMessageId = ctx.metadata.parentMessageId ? Number(ctx.metadata.parentMessageId) : null;
    const modelType = getModelType(request.providerModel || request.model);
    console.log(
      `[DEEPSEEK] completion payload: sessionId=${ctx.sessionId.slice(0, 12)} ` +
        `parentMsgId=${parentMessageId} modelType=${modelType} promptLen=${prompt.length} ` +
        `refFiles=${refFileIds.length}`,
    );
    const payload: DeepSeekCompletionPayload = {
      chat_session_id: ctx.sessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      thinking_enabled: !!request.reasoningEffort,
      search_enabled: true,
      ref_file_ids: refFileIds.length > 0 ? refFileIds : [],
    };

    const streamId = `ds-${Date.now()}`;
    let totalTokens = 0;
    let currentFragmentType: string | null = null;
    let firstChunk = true;
    let gotMessageId = false;
    let hasToolCalls = false;
    let toolCallIndex = 0;
    let tcCallId = '';
    let tcName = '';
    const sieve = new ToolSieve();

    try {
      for await (const line of client.streamCompletionLines(ctx.token, powResponse, payload, signal)) {
        if (signal?.aborted) return;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw.indexOf('FINISHED') >= 0 && raw.indexOf('response/status') >= 0) break;

        try {
          const chunk = JSON.parse(raw);

          if (!gotMessageId && chunk.response_message_id != null) {
            ctx.metadata.lastResponseMessageId = String(chunk.response_message_id);
            if (chunk.request_message_id != null) {
              ctx.metadata.lastRequestMessageId = String(chunk.request_message_id);
            }
            gotMessageId = true;
            continue;
          }
          const result = parseContent(chunk, currentFragmentType);
          if (result) {
            currentFragmentType = result.nextType;
            if (result.content || result.reasoningContent) {
              const content = result.content;
              let reasoning = result.reasoningContent;

              if (firstChunk && ctx.metadata.conversationId && !this.sentConversationId.has(ctx.sessionId)) {
                yield {
                  id: streamId,
                  model: request.model,
                  content: '',
                  reasoningContent: `#conversation_id:${ctx.metadata.conversationId}\n`,
                  finishReason: null,
                };
                this.sentConversationId.add(ctx.sessionId);
              }
              firstChunk = false;

              if (content) {
                const events = sieve.processChunk(content);
                for (const ev of events) {
                  if (ev.type === 'content' && hasText(ev.text)) {
                    totalTokens += this.estimateTokens(ev.text);
                    yield {
                      id: streamId,
                      model: request.model,
                      content: ev.text,
                      reasoningContent: reasoning || undefined,
                      finishReason: null,
                    };
                    reasoning = undefined;
                  } else if (ev.type === 'tool_call_start') {
                    hasToolCalls = true;
                    toolCallIndex++;
                    tcCallId = '';
                    tcName = '';
                  } else if (ev.type === 'tool_call_field_delta') {
                    if (ev.field === 'id') tcCallId += ev.text || '';
                    else if (ev.field === 'name') tcName += ev.text || '';
                    else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
                      totalTokens += this.estimateTokens(ev.text || '');
                      yield {
                        id: streamId,
                        model: request.model,
                        content: '',
                        toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
                        finishReason: null,
                      };
                    }
                  } else if (ev.type === 'tool_call_field_end') {
                    if (ev.field === 'name') {
                      const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
                      totalTokens += this.estimateTokens(tcName);
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
              } else if (hasText(reasoning)) {
                yield {
                  id: streamId,
                  model: request.model,
                  content: '',
                  reasoningContent: reasoning,
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

    // Flush remaining sieved content
    const flushEvents = sieve.flush();
    for (const ev of flushEvents) {
      if (ev.type === 'content' && hasText(ev.text)) {
        totalTokens += this.estimateTokens(ev.text);
        yield {
          id: streamId,
          model: request.model,
          content: ev.text,
          finishReason: null,
        };
      } else if (ev.type === 'tool_call_start') {
        hasToolCalls = true;
        toolCallIndex++;
        tcCallId = '';
        tcName = '';
      } else if (ev.type === 'tool_call_field_delta') {
        if (ev.field === 'id') tcCallId += ev.text || '';
        else if (ev.field === 'name') tcName += ev.text || '';
        else if (ev.field === 'arguments' || ev.field?.startsWith('arguments')) {
          totalTokens += this.estimateTokens(ev.text || '');
          yield {
            id: streamId,
            model: request.model,
            content: '',
            toolCallDelta: { index: toolCallIndex - 1, function: { arguments: ev.text } },
            finishReason: null,
          };
        }
      } else if (ev.type === 'tool_call_field_end') {
        if (ev.field === 'name') {
          const callId = tcCallId || `call_${streamId}_${toolCallIndex - 1}_${tcName}`;
          totalTokens += this.estimateTokens(tcName);
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

    this.uploadedFileIds = [];

    const normInputTokens = this.estimateTokens(prompt);
    const normCumulative = this.accumulateTokens(ctx.sessionId, normInputTokens, totalTokens);
    yield {
      id: streamId,
      model: request.model,
      content: '',
      finishReason: hasToolCalls ? 'tool_calls' : 'stop',
      usage: { inputTokens: normInputTokens, outputTokens: totalTokens, ...normCumulative },
    };
  }

  async dispose(ctx: SessionContext): Promise<void> {
    this.sentSystemPrompt.delete(ctx.sessionId);
    this.sentToolsHash.delete(ctx.sessionId);
    this.sentConversationId.delete(ctx.sessionId);
    this.conversationTokens.delete(ctx.sessionId);
    try {
      await client.deleteSession(ctx.token, ctx.sessionId);
    } catch {
      /* ignore */
    }
  }

  private async prepareVisionRequest(
    ctx: SessionContext,
    request: InternalRequest,
    signal?: AbortSignal,
  ): Promise<InternalRequest> {
    const cachedSummaries = (ctx.metadata.cachedImageSummaries as ImageSummary[] | undefined) ?? [];
    const imageMessages = request.messages.filter(hasImageMessage);
    if (imageMessages.length === 0) {
      if (cachedSummaries.length === 0) return request;
      return {
        ...request,
        messages: rewriteMessagesWithVisionHandoffs(request.messages, cachedSummaries),
      };
    }

    const visionSummary = await this.runVisionSideSession(ctx.token, request, signal);
    if (!hasText(visionSummary)) {
      throw new Error('Vision side-session returned empty summary');
    }

    const summaries: ImageSummary[] = imageMessages.map((msg) => ({
      messageHash: hashMessage(msg),
      summary: visionSummary,
      imageCount: countImageBlocks(msg),
    }));
    ctx.metadata.imageSummaries = [
      ...((ctx.metadata.imageSummaries as ImageSummary[] | undefined) ?? []),
      ...summaries,
    ];

    console.log(
      `[VISION] prepared handoff summaries=${summaries.length} imageCount=${summaries.reduce(
        (sum, item) => sum + item.imageCount,
        0,
      )}`,
    );

    return {
      ...request,
      messages: rewriteMessagesWithVisionHandoffs(request.messages, [...cachedSummaries, ...summaries]),
    };
  }

  private async runVisionSideSession(token: string, request: InternalRequest, signal?: AbortSignal): Promise<string> {
    const tempSessionId = await client.createSession(token);
    const imageRefs = extractImageRefs(request.messages as Array<{ role: string; content: unknown }>);
    const refFileIds = imageRefs.length > 0 ? await uploadImageRefs(token, imageRefs) : [];
    let text = '';
    let currentFragmentType: string | null = null;

    try {
      const prompt = buildVisionPrompt(request);
      const powResponse = await client.getPowForTarget(token, '/api/v0/chat/completion');
      const payload: DeepSeekCompletionPayload = {
        chat_session_id: tempSessionId,
        parent_message_id: null,
        model_type: 'vision',
        prompt,
        thinking_enabled: false,
        search_enabled: false,
        ref_file_ids: refFileIds,
      };

      console.log(
        `[VISION] temp completion session=${tempSessionId.slice(0, 12)} promptLen=${prompt.length} refFiles=${refFileIds.length}`,
      );

      for await (const line of client.streamCompletionLines(token, powResponse, payload, signal)) {
        if (signal?.aborted) break;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw.indexOf('FINISHED') >= 0 && raw.indexOf('response/status') >= 0) break;
        try {
          const chunk = JSON.parse(raw);
          const result = parseContent(chunk, currentFragmentType);
          if (result) {
            currentFragmentType = result.nextType;
            text += result.content;
          }
        } catch {
          continue;
        }
      }

      console.log(`[VISION] temp summary chars=${text.length}`);
      return text.trim();
    } finally {
      try {
        await client.deleteSession(token, tempSessionId);
        console.log(`[VISION] deleted temp session=${tempSessionId.slice(0, 12)}`);
      } catch (err) {
        console.warn(`[VISION] failed to delete temp session=${tempSessionId.slice(0, 12)}: ${(err as Error).message}`);
      }
    }
  }

  private async buildPromptAndFiles(
    token: string,
    sessionId: string,
    request: InternalRequest,
    forceTools = false,
    isRestoredSession = false,
  ): Promise<{ prompt: string; refFileIds: string[] }> {
    const messages = request.messages;
    const tools = request.tools as ToolDef[] | undefined;
    const hasTools = !!(tools && tools.length > 0);

    // Upload images first
    const imageRefs = extractImageRefs(messages as Array<{ role: string; content: unknown }>);
    const imageFileIds = imageRefs.length > 0 ? await uploadImageRefs(token, imageRefs) : [];
    const unsupportedImageErrors = countUnsupportedImageErrors(messages);
    console.log(
      `[DEEPSEEK] media: modelType=${getModelType(request.providerModel || request.model)} imageRefs=${imageRefs.length} ` +
        `uploadedImages=${imageFileIds.length} unsupportedImageErrors=${unsupportedImageErrors}`,
    );

    // Capture before sentSystemPrompt is mutated below
    // isRestoredSession: DB restore sau restart — session đã có history, không phải conversation mới
    const isNewConversation = !isRestoredSession && !this.sentSystemPrompt.has(sessionId);

    if (isRestoredSession) {
      this.sentSystemPrompt.add(sessionId);
    }

    // Top section: TOOL_SYSTEM_PROMPT + (optional) tools block
    // Inject system prompt only on new conversation or when tools change
    const topParts: string[] = [];

    let toolsChanged = false;
    if (hasTools) {
      const toolsHash = crypto.createHash('md5').update(JSON.stringify(tools)).digest('hex');
      const prevHash = this.sentToolsHash.get(sessionId);
      if (isRestoredSession && prevHash === undefined) {
        // Sau restart, sentToolsHash bị mất. Seed lại từ request hiện tại
        // mà không coi là toolsChanged — session đã có tools từ trước.
        this.sentToolsHash.set(sessionId, toolsHash);
      } else {
        toolsChanged = forceTools || toolsHash !== prevHash;
        if (toolsChanged) {
          this.sentToolsHash.set(sessionId, toolsHash);
        }
      }
    }

    if (isNewConversation || toolsChanged) {
      this.sentSystemPrompt.add(sessionId);
      topParts.push(TOOL_SYSTEM_PROMPT);
    }

    if (hasTools && toolsChanged) {
      topParts.push(buildToolPrompt(tools!));
    }

    // Message section: on new conversation send all messages (assistant included).
    // On subsequent requests, skip assistant — DeepSeek API is stateful
    // (chat_session_id + parent_message_id), so the server already knows what the assistant said.
    const messageXml = messages
      .filter((m) => isNewConversation || m.role !== 'assistant')
      .map((m) => renderMessageBlock(m as InternalMessage))
      .join('\n\n');

    const t0 = Date.now();
    let prompt: string;
    const fileIds: string[] = [];

    const fullPrompt = [...topParts, messageXml].join('\n\n');

    if (fullPrompt.length >= FILE_UPLOAD_THRESHOLD) {
      console.log(
        `[DEEPSEEK] prompt size=${fullPrompt.length} >= threshold=${FILE_UPLOAD_THRESHOLD}, uploading message blocks as file`,
      );
      const filename = `${this.name}_${Date.now()}.txt`;

      let fileContent: string;
      let inlineXml: string;

      if (isNewConversation) {
        // New conversation: API chưa có history. Đưa tất cả messages TRỪ message cuối vào file,
        // message cuối cùng nằm trong prompt inline (tránh duplicate).
        const lastMsg = messages[messages.length - 1];
        const historyMsgs = messages.slice(0, -1);
        fileContent =
          historyMsgs.map((m) => renderMessageBlock(m as InternalMessage)).join('\n\n') || '(empty history)';
        inlineXml = renderMessageBlock(lastMsg as InternalMessage);
      } else {
        // Có cache: API đã có history stateful. Không cần gửi lại context cũ.
        // Tất cả message trong request đều là message mới → nằm trong prompt inline.
        fileContent =
          '(Previous context is maintained by the chat session. See inline messages below for the current request.)';
        inlineXml = messageXml;
      }

      const uploadResult = await client.uploadFile(token, filename, fileContent);
      this.uploadedFileIds.push(uploadResult.id);
      fileIds.push(uploadResult.id);
      await client.pollFileReady(token, uploadResult.id);

      const fileParts = [
        ...topParts,
        block('system', `Please read the attached file (${filename}) to understand the context.`),
        inlineXml,
      ];
      prompt = fileParts.join('\n\n');
    } else {
      console.log(`[DEEPSEEK] prompt size=${fullPrompt.length} < threshold=${FILE_UPLOAD_THRESHOLD}, inline`);
      prompt = fullPrompt;
    }
    console.log(`[DEEPSEEK] buildPromptAndFiles took ${Date.now() - t0}ms`);

    return {
      prompt,
      refFileIds: [...imageFileIds, ...fileIds],
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

function extractImageRefs(messages: Array<{ role: string; content: unknown }>): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const msg of messages) {
    if (typeof msg.content !== 'object' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'image_url' && (block.image_url as Record<string, unknown>)?.url) {
        const url = (block.image_url as Record<string, unknown>).url as string;
        const isDataUrl = url.startsWith('data:');
        refs.push({
          url,
          isDataUrl,
          mimeType: isDataUrl ? url.match(/data:(.+);base64/)?.[1] || 'image/png' : undefined,
        });
      }
    }
  }
  return refs;
}

function hasImageMessage(msg: InternalMessage): boolean {
  return Array.isArray(msg.content) && msg.content.some((block) => block.type === 'image_url' && !!block.image_url.url);
}

function countImageBlocks(msg: InternalMessage): number {
  if (!Array.isArray(msg.content)) return 0;
  return msg.content.filter((block) => block.type === 'image_url' && !!block.image_url.url).length;
}

function buildVisionPrompt(request: InternalRequest): string {
  const messages = request.messages.map((msg) => renderMessageBlock(msg)).join('\n\n');
  return [block('system', VISION_SYSTEM_PROMPT), messages].join('\n\n');
}

function rewriteMessagesWithVisionHandoffs(messages: InternalMessage[], summaries: ImageSummary[]): InternalMessage[] {
  const rewritten: InternalMessage[] = [];
  const summaryByHash = new Map(summaries.map((item) => [item.messageHash, item.summary]));
  const insertedHashes = new Set<string>();

  for (const msg of messages) {
    const messageHash = hashMessage(msg);
    const summary = summaryByHash.get(messageHash);
    if (summary && !insertedHashes.has(messageHash)) {
      rewritten.push({
        role: 'system',
        content:
          'Vì bạn không có tính năng vision, nên tôi đã dùng một model vision khác để phân tích yêu cầu người dùng và có được kết luận như sau. Hãy tiếp tục xử lý yêu cầu của user dựa trên kết luận này:\n\n' +
          `<vision_result>\n${summary.trim()}\n</vision_result>`,
      });
      insertedHashes.add(messageHash);
    }

    rewritten.push(stripImageContent(msg));
  }

  return rewritten;
}

function stripImageContent(msg: InternalMessage): InternalMessage {
  if (!Array.isArray(msg.content)) return msg;
  const text = msg.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const suffix = hasImageMessage(msg) ? '\n\n[image đã được phân tích trong system message phía trên]' : '';
  return { ...msg, content: text + suffix };
}

function renderMessageBlock(msg: InternalMessage): string {
  const text = messageContent(msg as any);
  if (msg.role === 'tool') {
    return toolBlock(msg.tool_call_id || 'unknown', text);
  }
  if (msg.role === 'system') {
    return block('system', text);
  }
  if (msg.role === 'assistant') {
    return block('assistant', text);
  }
  return block('user', text);
}

function countUnsupportedImageErrors(messages: InternalRequest['messages']): number {
  let count = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.includes('model does not support image input')) {
        count++;
      }
    }
  }
  return count;
}

async function uploadImageRefs(token: string, refs: ImageRef[]): Promise<string[]> {
  const fileIds: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
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
          console.error(`[IMAGE] Failed to download ${ref.url}: HTTP ${resp.status}`);
          continue;
        }
        const arrayBuf = await resp.arrayBuffer();
        data = Buffer.from(arrayBuf);
        const contentType = resp.headers.get('content-type') || 'image/png';
        mimeType = contentType.split(';')[0].trim();
        ext = mimeType.split('/')[1] || 'png';
      }

      const filename = `image_${Date.now()}_${i}.${ext}`;
      console.log(`[IMAGE] Uploading ${filename} (${data.length} bytes, ${mimeType})`);
      const result = await client.uploadImageFile(token, filename, data, mimeType);
      fileIds.push(result.id);
      await client.pollFileReady(token, result.id, { webHeaders: mimeType.toLowerCase().startsWith('image/') });
      console.log(`[IMAGE] Uploaded ${filename} -> ${result.id}`);
    } catch (err) {
      console.error(`[IMAGE] Error uploading image ${i}:`, (err as Error).message);
    }
  }
  return fileIds;
}

function messageContent(msg: {
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .map((b) => {
      if ('text' in b) return b.text ?? '';
      if ('image_url' in b) return '[image]';
      return '';
    })
    .join('');
}

function buildEditMessagePrompt(request: InternalRequest): string {
  const lastTrackedIndex = findLastTrackedMessageIndex(request.messages);
  if (lastTrackedIndex < 0) return '';

  const lastTracked = request.messages[lastTrackedIndex];
  if (lastTracked.role === 'tool') {
    let firstToolIndex = lastTrackedIndex;
    while (firstToolIndex > 0 && request.messages[firstToolIndex - 1].role === 'tool') {
      firstToolIndex--;
    }

    const toolBlocks = request.messages
      .slice(firstToolIndex, lastTrackedIndex + 1)
      .map((m) => {
        const toolCallId = m.tool_call_id || 'unknown';
        return toolBlock(toolCallId, messageContent(m as any));
      })
      .join('\n\n');

    return toolBlocks;
  }

  return messageContent(lastTracked as any);
}

function findLastTrackedMessageIndex(messages: InternalRequest['messages']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'tool') return i;
  }
  return -1;
}

interface ParsedResult {
  content: string;
  reasoningContent?: string;
  nextType: string | null;
}

const SKIP_PATTERNS = [
  'status',
  'quasi_status',
  'elapsed_secs',
  'token_usage',
  'pending_fragment',
  'conversation_mode',
  'search_status',
];

function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some((p) => path.includes(p));
}

function isContentPath(p: string): boolean {
  return p.endsWith('/content') || p.includes('/content/');
}

function isThinkingPath(p: string): boolean {
  return p.endsWith('/thinking_content') || p.includes('/thinking_content/');
}

function parseFragments(fragments: Array<Record<string, unknown>>): {
  text: string;
  thinking: string;
  nextType: 'text' | 'thinking' | null;
} {
  let text = '';
  let thinking = '';
  let nextType: 'text' | 'thinking' | null = null;
  for (const frag of fragments) {
    const t = frag.type as string;
    const c = frag.content as string;
    if (!c) continue;
    if (t === 'THINK' || t === 'THINKING') {
      thinking += c;
      nextType = 'thinking';
    } else if (t === 'RESPONSE') {
      text += c;
      nextType = 'text';
    }
  }
  return { text, thinking, nextType };
}

function parseContent(chunk: Record<string, unknown>, currentFragmentType: string | null): ParsedResult | null {
  const path = chunk.p as string | undefined;
  const op = chunk.o as string | undefined;

  if (path && shouldSkip(path)) return null;

  // batch fragments: {"p":"response/fragments","o":"APPEND","v":[{...}]}
  if (path === 'response/fragments' && op === 'APPEND' && Array.isArray(chunk.v)) {
    const frags = chunk.v as Array<Record<string, unknown>>;
    const { text, thinking, nextType } = parseFragments(frags);
    if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
  }

  // nested response with fragments: {"v":{"response":{"fragments":[{...}]}}}
  if (!path && !op && chunk.v && typeof chunk.v === 'object') {
    const vObj = chunk.v as Record<string, unknown>;
    const response = vObj.response as Record<string, unknown> | undefined;
    if (response?.fragments && Array.isArray(response.fragments)) {
      const { text, thinking, nextType } = parseFragments(response.fragments as Array<Record<string, unknown>>);
      if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
    }
  }

  // content path: {"p":"response/fragments/-1/content","o":"APPEND","v":"..."}
  const text = extractTextValue(chunk.v);
  if (!text) return null;

  if (path && isContentPath(path)) {
    if (currentFragmentType === 'thinking') {
      return { content: '', reasoningContent: text, nextType: 'thinking' };
    }
    return { content: text, nextType: 'text' };
  }
  if (path && isThinkingPath(path)) {
    return { content: '', reasoningContent: text, nextType: 'thinking' };
  }

  // pathless chunk: {"v":" hello"} — uses tracked type
  if (!path && currentFragmentType) {
    return {
      content: currentFragmentType === 'thinking' ? '' : text,
      reasoningContent: currentFragmentType === 'thinking' ? text : undefined,
      nextType: currentFragmentType,
    };
  }

  return null;
}

function hasText(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function extractTextValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return (obj.text as string) || (obj.content as string) || '';
  }
  return '';
}

export const deepseekProvider: Provider = new DeepSeekProvider();
