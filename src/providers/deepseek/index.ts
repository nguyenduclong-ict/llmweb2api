import crypto from 'crypto';
import type { Provider, SessionContext } from '../../types/provider';
import type { InternalRequest, InternalResponse, InternalStreamChunk, ToolCallDelta } from '../../types/common';
import * as client from './client';
import type { DeepSeekCompletionPayload } from './types';
import { FILE_UPLOAD_THRESHOLD } from './types';
import { getModelType } from './models';
import { TOOL_SYSTEM_PROMPT, buildToolPrompt, block, BlockName } from './tool_prompt';
import { ToolSieve } from './tool_sieve';
import { parseToolCallXML } from './tool_parser';
import type { ParsedToolCall } from './tool_parser';

interface ImageRef {
  url: string;
  isDataUrl: boolean;
  mimeType?: string;
}

type ToolDef = {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

class DeepSeekProvider implements Provider {
  readonly name = 'deepseek';
  private uploadedFileIds: string[] = [];
  private sentToolsHash = new Map<string, string>();
  private sentSystemPrompt = new Set<string>();
  private conversationTokens = new Map<string, { inputTokens: number; outputTokens: number }>();

  private accumulateTokens(sessionId: string, inputTokens: number, outputTokens: number): {
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
    const { prompt, refFileIds } = await this.buildPromptAndFiles(ctx.token, ctx.sessionId, request);
    const powResponse = await client.getPowForTarget(ctx.token, '/api/v0/chat/completion');
    const parentMessageId = ctx.metadata.parentMessageId ? Number(ctx.metadata.parentMessageId) : null;
    const payload: DeepSeekCompletionPayload = {
      chat_session_id: ctx.sessionId,
      parent_message_id: parentMessageId,
      model_type: getModelType(request.providerModel || request.model),
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
    } else if (text.includes('[#llmweb2api:tool_call]')) {
      console.error('[DEEPSEEK] Non-stream: text contains tool_call marker but parsed 0 tool calls.');
      console.error('[DEEPSEEK] Full response text:', text);
    }

    // Inject conversation_id as first reasoning line (same as streaming)
    if (reasoning && ctx.metadata.conversationId) {
      reasoning = `#conversation_id:${ctx.metadata.conversationId}\n` + reasoning;
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
        id: `call_${Date.now()}_${tc.name}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
      usage: { inputTokens, outputTokens, ...cumulative },
    };
  }

  async *chatStream(ctx: SessionContext, request: InternalRequest): AsyncGenerator<InternalStreamChunk> {
    const editMessageId = ctx.metadata.editMessageId as number | undefined;

    // Regeneration via edit_message
    if (editMessageId) {
      const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user');
      const msgContent = lastUserMsg
        ? typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg.content)
            ? lastUserMsg.content.map((b: any) => b.text || '').join('')
            : ''
        : '';
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
      const sieve = new ToolSieve();

      for await (const line of client.streamEditMessageLines(ctx.token, powResponse, editPayload)) {
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

              if (firstChunk && ctx.metadata.conversationId) {
                yield {
                  id: streamId,
                  model: request.model,
                  content: '',
                  reasoningContent: `#conversation_id:${ctx.metadata.conversationId}\n`,
                  finishReason: null,
                };
                firstChunk = false;
              }

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
                  } else if (ev.type === 'tool_calls' && ev.toolCalls) {
                    hasToolCalls = true;
                    for (const delta of buildToolCallDeltas(ev.toolCalls, streamId)) {
                      yield {
                        id: streamId,
                        model: request.model,
                        content: '',
                        toolCallDelta: delta,
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

      // Flush
      const flushEvents = sieve.flush();
      for (const ev of flushEvents) {
        if (ev.type === 'content' && hasText(ev.text)) {
          totalTokens += this.estimateTokens(ev.text);
          yield { id: streamId, model: request.model, content: ev.text, finishReason: null };
        } else if (ev.type === 'tool_calls' && ev.toolCalls) {
          hasToolCalls = true;
          for (const delta of buildToolCallDeltas(ev.toolCalls, streamId)) {
            yield { id: streamId, model: request.model, content: '', toolCallDelta: delta, finishReason: null };
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
    const { prompt, refFileIds } = await this.buildPromptAndFiles(ctx.token, ctx.sessionId, request);
    const powResponse = await client.getPowForTarget(ctx.token, '/api/v0/chat/completion');
    const parentMessageId = ctx.metadata.parentMessageId ? Number(ctx.metadata.parentMessageId) : null;
    const payload: DeepSeekCompletionPayload = {
      chat_session_id: ctx.sessionId,
      parent_message_id: parentMessageId,
      model_type: getModelType(request.providerModel || request.model),
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
    const sieve = new ToolSieve();

    for await (const line of client.streamCompletionLines(ctx.token, powResponse, payload)) {
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

            if (firstChunk && ctx.metadata.conversationId) {
              yield {
                id: streamId,
                model: request.model,
                content: '',
                reasoningContent: `#conversation_id:${ctx.metadata.conversationId}\n`,
                finishReason: null,
              };
              firstChunk = false;
            }

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
                } else if (ev.type === 'tool_calls' && ev.toolCalls) {
                  hasToolCalls = true;
                  for (const delta of buildToolCallDeltas(ev.toolCalls, streamId)) {
                    yield {
                      id: streamId,
                      model: request.model,
                      content: '',
                      toolCallDelta: delta,
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
      } else if (ev.type === 'tool_calls' && ev.toolCalls) {
        hasToolCalls = true;
        for (const delta of buildToolCallDeltas(ev.toolCalls, streamId)) {
          yield {
            id: streamId,
            model: request.model,
            content: '',
            toolCallDelta: delta,
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
    this.conversationTokens.delete(ctx.sessionId);
    try {
      await client.deleteSession(ctx.token, ctx.sessionId);
    } catch {
      /* ignore */
    }
  }

  private async buildPromptAndFiles(
    token: string,
    sessionId: string,
    request: InternalRequest,
  ): Promise<{ prompt: string; refFileIds: string[] }> {
    const messages = request.messages;
    const tools = request.tools as ToolDef[] | undefined;
    const hasTools = !!(tools && tools.length > 0);

    // Upload images first
    const imageRefs = extractImageRefs(messages as Array<{ role: string; content: unknown }>);
    const imageFileIds = imageRefs.length > 0 ? await uploadImageRefs(token, imageRefs) : [];

    // Top section: TOOL_SYSTEM_PROMPT + (optional) tools block
    // Inject system prompt only on new conversation or when tools change
    const topParts: string[] = [];

    let toolsChanged = false;
    if (hasTools) {
      const toolsHash = crypto.createHash('md5').update(JSON.stringify(tools)).digest('hex');
      const prevHash = this.sentToolsHash.get(sessionId);
      toolsChanged = toolsHash !== prevHash;
      if (toolsChanged) {
        this.sentToolsHash.set(sessionId, toolsHash);
      }
    }

    if (!this.sentSystemPrompt.has(sessionId) || toolsChanged) {
      this.sentSystemPrompt.add(sessionId);
      topParts.push(TOOL_SYSTEM_PROMPT);
    }

    if (hasTools && toolsChanged) {
      topParts.push(buildToolPrompt(tools!));
    }

    // Message section: only user + tool messages.
    // Skip assistant — DeepSeek API is stateful (chat_session_id + parent_message_id),
    // so the server already knows what the assistant said.
    const messageXml = messages
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .map((m) => {
        const text = messageContent(m as any);
        if (m.role === 'tool') {
          return block('tool', text);
        }
        return block('user', text);
      })
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
      const uploadResult = await client.uploadFile(token, filename, messageXml);
      this.uploadedFileIds.push(uploadResult.id);
      fileIds.push(uploadResult.id);
      await client.pollFileReady(token, uploadResult.id);

      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
      const fileParts = [
        ...topParts,
        block('system', `Please read the attached file (${filename}) to understand the context.`),
      ];
      if (lastUserMsg) {
        const userContent =
          typeof lastUserMsg.content === 'string' ? lastUserMsg.content : messageContent(lastUserMsg as any);
        fileParts.push(block('user', userContent));
      }
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
      const result = await client.uploadFile(token, filename, data, mimeType);
      fileIds.push(result.id);
      await client.pollFileReady(token, result.id);
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

function buildToolCallDeltas(toolCalls: ParsedToolCall[], streamId: string): ToolCallDelta[] {
  const deltas: ToolCallDelta[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const callId = `call_${streamId}_${i}_${tc.name}`;

    // First delta: index, id, type, function.name
    deltas.push({
      index: i,
      id: callId,
      type: 'function',
      function: { name: tc.name, arguments: '' },
    });

    // Arguments delta: the full JSON string
    const argsJson = JSON.stringify(tc.arguments);
    deltas.push({
      index: i,
      function: { arguments: argsJson },
    });
  }
  return deltas;
}

export const deepseekProvider: Provider = new DeepSeekProvider();
