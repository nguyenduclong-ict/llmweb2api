import type { Provider, SessionContext } from '../../types/provider';
import type {
  ContentBlock,
  FileContent,
  ImageContent,
  InternalMessage,
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
} from '../../types/common';
import * as client from './client';
import { toChatGptUpstreamModel } from './models';
import { TOOL_SYSTEM_PROMPT, block, buildToolPrompt, toolBlock } from '../core/tool_prompt';
import { ToolSieve } from '../core/tool_sieve';

const FILE_UPLOAD_THRESHOLD = 100 * 1024;

interface ChatGptSessionMetadata extends Record<string, unknown> {
  accountMeta?: client.ChatGptAccountMeta;
}

class ChatGPTProvider implements Provider {
  readonly name = 'chatgpt';
  private conversationTokens = new Map<string, { inputTokens: number; outputTokens: number }>();
  private sentSystemPrompt = new Set<string>();
  private sentToolsHash = new Map<string, string>();

  async login(settings: Record<string, unknown>): Promise<SessionContext> {
    const token = typeof settings.token === 'string' ? settings.token.trim() : '';
    if (!token) throw new Error('ChatGPT requires token in settings');
    return {
      accountId: 0,
      token,
      sessionId: '',
      metadata: { accountMeta: client.buildAccountMeta(settings) },
    };
  }

  async createSession(ctx: SessionContext): Promise<SessionContext> {
    ctx.sessionId = `chatgpt-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ctx.metadata.parentMessageId = undefined;
    return ctx;
  }

  async chat(ctx: SessionContext, request: InternalRequest): Promise<InternalResponse> {
    let content = '';
    let finishReason = 'stop';
    let usage: InternalResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of this.chatStream(ctx, request)) {
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
    return {
      id: `chatgpt-${Date.now()}`,
      model: request.model,
      content,
      finishReason,
      usage,
    };
  }

  async *chatStream(
    ctx: SessionContext,
    request: InternalRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<InternalStreamChunk> {
    const accountMeta = this.getAccountMeta(ctx);
    const providerModel = request.providerModel || request.model;
    const thinking = !!request.thinking;
    const model = toChatGptUpstreamModel(providerModel, thinking);
    const upstreamConversationId = isUpstreamConversationId(ctx.sessionId) ? ctx.sessionId : undefined;
    const parentMessageId = stringValue(ctx.metadata.parentMessageId);
    const { prompt, attachments } = await this.buildPromptAndFiles(ctx, accountMeta, request, !!parentMessageId);
    const streamId = `chatgpt-${Date.now()}`;

    console.log(
      `[CHATGPT] stream: upstreamConv=${upstreamConversationId || '<new>'} parent=${parentMessageId || '<root>'} ` +
        `msgs=${request.messages.length} files=${attachments.length} model=${model} thinking=${thinking}`,
    );

    let output = '';
    let reasoning = '';
    let lastFinishReason: string | undefined;
    let hasToolCalls = false;
    let toolCallIndex = -1;
    let currentField: string | null = null;
    let currentToolCall: { id?: string; name?: string; arguments: string } = { arguments: '' };
    const sieve = new ToolSieve();
    for await (const event of client.streamConversation(
      ctx.token,
      accountMeta,
      {
        model,
        messages: [client.makeUserMessage(prompt, attachments)],
        conversationId: upstreamConversationId,
        parentMessageId,
        attachments,
        thinking,
        reasoningEffort: request.reasoningEffort,
      },
      signal,
    )) {
      if (signal?.aborted) return;
      if (event.conversationId) {
        this.migrateSessionState(ctx.sessionId, event.conversationId);
        ctx.sessionId = event.conversationId;
        ctx.metadata.providerConversationId = event.conversationId;
      }
      if (event.assistantMessageId) {
        ctx.metadata.lastResponseMessageId = event.assistantMessageId;
        ctx.metadata.parentMessageId = event.assistantMessageId;
      }
      if (event.finishReason) lastFinishReason = event.finishReason;
      if (event.reasoningDelta) {
        reasoning += event.reasoningDelta;
        yield {
          id: streamId,
          model: request.model,
          content: '',
          reasoningContent: event.reasoningDelta,
          finishReason: null,
          conversationId: request.conversationId,
        };
      }
      if (event.textDelta) {
        output += event.textDelta;
        const events = request.tools?.length
          ? sieve.processChunk(event.textDelta)
          : [{ type: 'content' as const, text: event.textDelta }];
        for (const ev of events) {
          if (ev.type === 'content' && ev.text) {
            yield {
              id: streamId,
              model: request.model,
              content: ev.text,
              finishReason: null,
              conversationId: request.conversationId,
            };
          } else if (ev.type === 'tool_call_start') {
            hasToolCalls = true;
            toolCallIndex++;
            currentToolCall = { arguments: '' };
          } else if (ev.type === 'tool_call_field_start') {
            currentField = ev.field || null;
          } else if (ev.type === 'tool_call_field_delta') {
            if (currentField === 'id') currentToolCall.id = (currentToolCall.id || '') + (ev.text || '');
            if (currentField === 'name') currentToolCall.name = (currentToolCall.name || '') + (ev.text || '');
            if (currentField === 'arguments') {
              currentToolCall.arguments += ev.text || '';
              yield {
                id: streamId,
                model: request.model,
                content: '',
                finishReason: null,
                toolCallDelta: { index: toolCallIndex, function: { arguments: ev.text || '' } },
                conversationId: request.conversationId,
              };
            }
          } else if (ev.type === 'tool_call_field_end') {
            currentField = null;
          } else if (ev.type === 'tool_call_end') {
            const name = (currentToolCall.name || 'tool').trim();
            const callId = (currentToolCall.id || `call_${streamId}_${toolCallIndex}_${name}`).trim();
            yield {
              id: streamId,
              model: request.model,
              content: '',
              finishReason: null,
              toolCallDelta: {
                index: toolCallIndex,
                id: callId,
                type: 'function',
                function: { name, arguments: currentToolCall.arguments.trim() },
              },
              conversationId: request.conversationId,
            };
          }
        }
      }
      if (event.done) break;
    }

    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(output);
    const cumulative = this.accumulateTokens(ctx.sessionId, inputTokens, outputTokens);
    yield {
      id: streamId,
      model: request.model,
      content: '',
      reasoningContent: reasoning || undefined,
      finishReason: hasToolCalls ? 'tool_calls' : lastFinishReason || 'stop',
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: reasoning ? estimateTokens(reasoning) : undefined,
        ...cumulative,
      },
      conversationId: request.conversationId,
    };
  }

  async dispose(ctx: SessionContext): Promise<void> {
    const accountMeta = this.getAccountMeta(ctx);
    const uploadedFileIds = Array.isArray(ctx.metadata.uploadedFileIds)
      ? (ctx.metadata.uploadedFileIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    for (const fileId of uploadedFileIds) {
      try {
        await client.deleteFile(ctx.token, accountMeta, fileId);
      } catch (err) {
        console.warn(`[CHATGPT] failed to delete file ${fileId}: ${(err as Error).message}`);
      }
    }
    ctx.metadata.uploadedFileIds = [];

    if (isUpstreamConversationId(ctx.sessionId)) {
      try {
        await client.deleteConversation(ctx.token, accountMeta, ctx.sessionId);
      } catch (err) {
        console.warn(`[CHATGPT] failed to hide conversation ${ctx.sessionId}: ${(err as Error).message}`);
      }
    }
    this.sentSystemPrompt.delete(ctx.sessionId);
    this.sentToolsHash.delete(ctx.sessionId);
    this.conversationTokens.delete(ctx.sessionId);
  }

  private getAccountMeta(ctx: SessionContext): client.ChatGptAccountMeta {
    const metadata = ctx.metadata as ChatGptSessionMetadata;
    if (metadata.accountMeta) return metadata.accountMeta;
    const settings =
      metadata.accountSettings && typeof metadata.accountSettings === 'object'
        ? (metadata.accountSettings as Record<string, unknown>)
        : {};
    const session =
      metadata.accountSession && typeof metadata.accountSession === 'object'
        ? (metadata.accountSession as Record<string, unknown>)
        : {};
    metadata.accountMeta = client.buildAccountMeta(settings, session);
    return metadata.accountMeta;
  }

  private async uploadRequestFiles(
    ctx: SessionContext,
    token: string,
    accountMeta: client.ChatGptAccountMeta,
    messages: InternalMessage[],
  ): Promise<client.UploadedFile[]> {
    const uploaded: client.UploadedFile[] = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const file =
          block.type === 'input_file'
            ? await resolveFileBlock(block)
            : block.type === 'image_url'
              ? await resolveImageBlock(block, uploaded.length)
              : undefined;
        if (!file) continue;
        const upload = await client.uploadFile(token, accountMeta, file.filename, file.bytes, file.mimeType);
        uploaded.push(upload);
        const ids = Array.isArray(ctx.metadata.uploadedFileIds) ? (ctx.metadata.uploadedFileIds as string[]) : [];
        ctx.metadata.uploadedFileIds = [...ids, upload.fileId];
      }
    }
    return uploaded;
  }

  private async buildPromptAndFiles(
    ctx: SessionContext,
    accountMeta: client.ChatGptAccountMeta,
    request: InternalRequest,
    isContinuation: boolean,
  ): Promise<{ prompt: string; attachments: client.UploadedFile[] }> {
    const t0 = Date.now();
    const attachments = await this.uploadRequestFiles(ctx, ctx.token, accountMeta, request.messages);
    const sessionId = ctx.sessionId;
    const tools = request.tools as Parameters<typeof buildToolPrompt>[0] | undefined;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const isRestoredSession = isContinuation && !this.sentSystemPrompt.has(sessionId);
    const isNewConversation = !isContinuation && !this.sentSystemPrompt.has(sessionId);

    if (isRestoredSession) {
      this.sentSystemPrompt.add(sessionId);
    }

    let toolsChanged = false;
    let toolsFileContent: string | null = null;
    if (hasTools) {
      const toolsHash = hashStable(tools);
      const prevHash = this.sentToolsHash.get(sessionId);
      if (isRestoredSession && prevHash === undefined) {
        this.sentToolsHash.set(sessionId, toolsHash);
        toolsChanged = true;
      } else {
        toolsChanged = toolsHash !== prevHash;
        if (toolsChanged) this.sentToolsHash.set(sessionId, toolsHash);
      }
    }

    if (isNewConversation || toolsChanged) {
      this.sentSystemPrompt.add(sessionId);
      const parts: string[] = [TOOL_SYSTEM_PROMPT];
      if (hasTools) parts.push(buildToolPrompt(tools));
      toolsFileContent = parts.join('\n\n');
    }

    const messageXml = request.messages
      .filter((m) => isNewConversation || m.role !== 'assistant')
      .map((m) => renderMessageBlock(m))
      .join('\n\n');

    let toolFileInstruction = '';
    if (toolsFileContent) {
      const toolFilename = `${this.name}_tools_${Date.now()}.txt`;
      const upload = await this.uploadGeneratedFile(ctx, accountMeta, toolFilename, toolsFileContent);
      attachments.push(upload);
      toolFileInstruction = block(
        'system',
        `Please read the attached file (${toolFilename}) to understand the context.`,
      );
    }

    const fullPrompt = [toolFileInstruction, messageXml].filter(Boolean).join('\n\n');
    let prompt: string;
    if (fullPrompt.length >= FILE_UPLOAD_THRESHOLD) {
      console.log(
        `[CHATGPT] prompt size=${fullPrompt.length} >= threshold=${FILE_UPLOAD_THRESHOLD}, uploading message blocks as file`,
      );
      const filename = `${this.name}_${Date.now()}.txt`;
      let fileContent: string;
      let inlineXml: string;

      if (isNewConversation) {
        const lastMsg = request.messages[request.messages.length - 1];
        const historyMsgs = request.messages.slice(0, -1);
        fileContent = historyMsgs.map((m) => renderMessageBlock(m)).join('\n\n') || '(empty history)';
        inlineXml = lastMsg ? renderMessageBlock(lastMsg) : '(empty)';
      } else {
        fileContent =
          '(Previous context is maintained by the chat session. See inline messages below for the current request.)';
        inlineXml = messageXml;
      }

      const upload = await this.uploadGeneratedFile(ctx, accountMeta, filename, fileContent);
      attachments.push(upload);
      prompt = [
        toolFileInstruction,
        block('system', `Please read the attached file (${filename}) to understand the context.`),
        inlineXml,
      ]
        .filter(Boolean)
        .join('\n\n');
    } else {
      console.log(`[CHATGPT] prompt size=${fullPrompt.length} < threshold=${FILE_UPLOAD_THRESHOLD}, inline`);
      prompt = fullPrompt;
    }

    console.log(`[CHATGPT] buildPromptAndFiles took ${Date.now() - t0}ms`);
    return { prompt, attachments };
  }

  private async uploadGeneratedFile(
    ctx: SessionContext,
    accountMeta: client.ChatGptAccountMeta,
    filename: string,
    content: string,
  ): Promise<client.UploadedFile> {
    const upload = await client.uploadFile(ctx.token, accountMeta, filename, Buffer.from(content), 'text/plain');
    const ids = Array.isArray(ctx.metadata.uploadedFileIds) ? (ctx.metadata.uploadedFileIds as string[]) : [];
    ctx.metadata.uploadedFileIds = [...ids, upload.fileId];
    return upload;
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
    return { cumulativeInputTokens: prev.inputTokens, cumulativeOutputTokens: prev.outputTokens };
  }

  private migrateSessionState(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || fromSessionId === toSessionId) return;

    if (this.sentSystemPrompt.has(fromSessionId)) {
      this.sentSystemPrompt.add(toSessionId);
      this.sentSystemPrompt.delete(fromSessionId);
    }

    const toolsHash = this.sentToolsHash.get(fromSessionId);
    if (toolsHash !== undefined) {
      this.sentToolsHash.set(toSessionId, toolsHash);
      this.sentToolsHash.delete(fromSessionId);
    }

    const tokens = this.conversationTokens.get(fromSessionId);
    if (tokens) {
      this.conversationTokens.set(toSessionId, tokens);
      this.conversationTokens.delete(fromSessionId);
    }
  }
}

async function resolveFileBlock(
  block: FileContent,
): Promise<{ filename: string; bytes: Uint8Array; mimeType: string } | undefined> {
  const filename = block.filename || block.file_id || `file_${Date.now()}.txt`;
  if (block.file_data) {
    const match = block.file_data.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { filename, bytes: Buffer.from(match[2], 'base64'), mimeType: match[1] };
    return { filename, bytes: Buffer.from(block.file_data), mimeType: 'text/plain' };
  }
  if (block.file_url) {
    const response = await fetch(block.file_url);
    if (!response.ok) throw new Error(`Failed to download ChatGPT input file: HTTP ${response.status}`);
    return {
      filename,
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    };
  }
  return undefined;
}

async function resolveImageBlock(
  block: ImageContent,
  index: number,
): Promise<{ filename: string; bytes: Uint8Array; mimeType: string } | undefined> {
  const url = block.image_url.url;
  if (!url) return undefined;
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return undefined;
    const mimeType = match[1] || 'image/png';
    return {
      filename: `image_${Date.now()}_${index}.${extensionFromMime(mimeType)}`,
      bytes: Buffer.from(match[2], 'base64'),
      mimeType,
    };
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ChatGPT input image: HTTP ${response.status}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  return {
    filename: `image_${Date.now()}_${index}.${extensionFromMime(mimeType)}`,
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType,
  };
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

function renderMessageBlock(msg: InternalMessage): string {
  const text = messageContent(msg.content);
  if (msg.role === 'tool') return toolBlock(msg.tool_call_id || 'unknown', text);
  if (msg.role === 'system') return block('system', text);
  if (msg.role === 'assistant') return block('assistant', text);
  return block('user', text);
}

function messageContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image_url') return `[image: ${block.image_url.url}]`;
      if (block.type === 'input_file')
        return `[attached file: ${block.filename || block.file_id || block.file_url || 'file'}]`;
      return '';
    })
    .join('');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isUpstreamConversationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hashStable(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

export const chatgptProvider: Provider = new ChatGPTProvider();
