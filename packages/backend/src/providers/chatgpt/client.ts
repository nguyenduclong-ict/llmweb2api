import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClientIdentifier, Session, initTLS } from 'node-tls-client';
import { buildLegacyRequirementsToken, buildProofToken, parsePowResources } from './pow';
import { solveTurnstileToken } from './turnstile';

const BASE_URL = 'https://chatgpt.com';
const DEFAULT_CLIENT_VERSION = 'prod-eba0f711266e2c6fc03a307d599f643861f69e1b';
const DEFAULT_CLIENT_BUILD_NUMBER = '6529387';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const STREAM_EOF = '__LLMWEB2API_CHATGPT_STREAM_EOF__';
const STREAM_POLL_MS = Number(process.env.CHATGPT_TLS_STREAM_POLL_MS || 25);
const TIMEOUT_MS = Number(process.env.CHATGPT_TLS_TIMEOUT_MS || 300000);
const RETRY_ATTEMPTS = Number(process.env.CHATGPT_RETRY_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.CHATGPT_RETRY_BASE_MS || 500);

let initPromise: Promise<void> | null = null;

export interface ChatGptAccountMeta {
  userAgent: string;
  deviceId: string;
  sessionId: string;
  clientVersion: string;
  clientBuildNumber: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  language: string;
  cookie?: string;
  xOaiIs?: string;
  trace?: (label: string, ms: number, details?: Record<string, unknown>) => void;
}

interface ChatRequirements {
  token: string;
  proofToken?: string;
  turnstileToken?: string;
  soToken?: string;
}

export interface UploadedFile {
  fileId: string;
  fileName: string;
  size: number;
}

export interface ConversationRequest {
  model: string;
  messages: ChatGptMessage[];
  conversationId?: string;
  parentMessageId?: string;
  attachments?: UploadedFile[];
  thinking?: boolean;
  reasoningEffort?: string;
}

export interface ChatGptMessage {
  id: string;
  author: { role: 'user' | 'assistant' | 'system' };
  create_time: number;
  content: { content_type: 'text'; parts: string[] };
  metadata: Record<string, unknown>;
}

export interface ParsedStreamEvent {
  done?: boolean;
  textDelta?: string;
  reasoningDelta?: string;
  conversationId?: string;
  assistantMessageId?: string;
  finishReason?: string;
  error?: string;
}

interface SseParseState {
  activeFinalMessageId?: string;
  sawAssistantContent?: boolean;
  currentContentType?: 'text' | 'reasoning';
}

export function buildAccountMeta(
  settings: Record<string, unknown>,
  session: Record<string, unknown> = {},
): ChatGptAccountMeta {
  const deviceId = stringValue(session.oaiDeviceId) || stringValue(settings.oaiDeviceId) || randomUUID();
  const sessionId = stringValue(session.oaiSessionId) || stringValue(settings.oaiSessionId) || randomUUID();
  return {
    userAgent: stringValue(settings.userAgent) || DEFAULT_USER_AGENT,
    deviceId,
    sessionId,
    clientVersion: stringValue(settings.clientVersion) || DEFAULT_CLIENT_VERSION,
    clientBuildNumber: stringValue(settings.clientBuildNumber) || DEFAULT_CLIENT_BUILD_NUMBER,
    secChUa: stringValue(settings.secChUa) || '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    secChUaMobile: stringValue(settings.secChUaMobile) || '?0',
    secChUaPlatform: stringValue(settings.secChUaPlatform) || '"Windows"',
    language: stringValue(settings.language) || 'vi-VN',
    cookie: stringValue(settings.cookie) || undefined,
    xOaiIs: stringValue(settings.xOaiIs) || undefined,
  };
}

export async function* streamConversation(
  token: string,
  meta: ChatGptAccountMeta,
  request: ConversationRequest,
  signal?: AbortSignal,
): AsyncGenerator<ParsedStreamEvent> {
  const totalStarted = Date.now();
  const requirements = await getChatRequirements(token, meta);
  const payload = buildConversationPayload(request, meta);
  const headers = {
    ...baseHeaders(token, meta, '/backend-api/f/conversation'),
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'openai-sentinel-chat-requirements-token': requirements.token,
    ...(requirements.proofToken ? { 'openai-sentinel-proof-token': requirements.proofToken } : {}),
    ...(requirements.turnstileToken ? { 'openai-sentinel-turnstile-token': requirements.turnstileToken } : {}),
    ...(requirements.soToken ? { 'openai-sentinel-so-token': requirements.soToken } : {}),
    'x-oai-turn-trace-id': randomUUID(),
    referer: request.conversationId ? `${BASE_URL}/c/${request.conversationId}` : `${BASE_URL}/`,
  };

  const parseState: SseParseState = {};
  let firstEventMs: number | undefined;
  let lineCount = 0;
  for await (const line of tlsStreamLines(
    {
      url: `${BASE_URL}/backend-api/f/conversation`,
      method: 'POST',
      headers,
      body: payload,
      onCookieHeader: (cookie) => {
        meta.cookie = mergeCookieHeaders(meta.cookie, cookie);
      },
    },
    signal,
  )) {
    if (signal?.aborted) return;
    lineCount++;
    const parsed = parseSseLine(line, parseState);
    if (parsed) {
      if (parsed.error) throw new Error(`ChatGPT stream error: ${parsed.error}`);
      if (firstEventMs === undefined) {
        firstEventMs = Date.now() - totalStarted;
        trace(meta, 'stream.first_event', firstEventMs, {
          conversationId: parsed.conversationId,
        });
      }
      yield parsed;
    }
  }
  trace(meta, 'stream.total', Date.now() - totalStarted, {
    lines: lineCount,
    conversationId: request.conversationId || '<new>',
  });
}

export async function uploadFile(
  token: string,
  meta: ChatGptAccountMeta,
  filename: string,
  bytes: Uint8Array,
  mimeType = 'application/octet-stream',
): Promise<UploadedFile> {
  const totalStarted = Date.now();
  const body = {
    file_name: filename,
    file_size: bytes.byteLength,
    use_case: 'my_files',
    timezone_offset_min: -420,
    reset_rate_limits: false,
    store_in_library: true,
    library_persistence_mode: 'opportunistic',
  };
  const createStarted = Date.now();
  const create = await tlsJson<{ upload_url: string; file_id: string }>({
    url: `${BASE_URL}/backend-api/files`,
    method: 'POST',
    headers: {
      ...baseHeaders(token, meta, '/backend-api/files'),
      accept: '*/*',
      'content-type': 'application/json',
      referer: `${BASE_URL}/`,
    },
    body,
  });
  trace(meta, 'upload.create', Date.now() - createStarted, { fileId: create.file_id, bytes: bytes.byteLength });

  const putStarted = Date.now();
  const uploadResponse = await withRetry(
    () =>
      fetch(create.upload_url, {
        method: 'PUT',
        headers: {
          'content-type': mimeType,
          'content-length': String(bytes.byteLength),
          'x-ms-blob-type': 'BlockBlob',
          'x-ms-version': '2020-04-08',
          origin: BASE_URL,
          referer: `${BASE_URL}/`,
          'user-agent': meta.userAgent,
        },
        body: Buffer.from(bytes),
      }),
    { url: create.upload_url, method: 'PUT', headers: {} },
  );
  if (!uploadResponse.ok) {
    throw new Error(
      `ChatGPT file upload failed: HTTP ${uploadResponse.status} ${(await uploadResponse.text()).slice(0, 500)}`,
    );
  }
  trace(meta, 'upload.put_blob', Date.now() - putStarted, { status: uploadResponse.status, bytes: bytes.byteLength });

  const commitStarted = Date.now();
  await tlsJson<unknown>({
    url: `${BASE_URL}/backend-api/files/${create.file_id}/uploaded`,
    method: 'POST',
    headers: {
      ...baseHeaders(token, meta, `/backend-api/files/${create.file_id}/uploaded`),
      accept: '*/*',
      'content-type': 'application/json',
      referer: `${BASE_URL}/`,
    },
    body: {},
  })
    .then(() => {
      trace(meta, 'upload.commit', Date.now() - commitStarted, { fileId: create.file_id });
    })
    .catch((err: unknown) => {
      trace(meta, 'upload.commit_failed', Date.now() - commitStarted, {
        fileId: create.file_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  trace(meta, 'upload.total', Date.now() - totalStarted, { fileId: create.file_id, bytes: bytes.byteLength });

  return { fileId: create.file_id, fileName: filename, size: bytes.byteLength };
}

export async function deleteConversation(
  token: string,
  meta: ChatGptAccountMeta,
  conversationId: string,
): Promise<void> {
  if (!conversationId) return;
  await tlsText({
    url: `${BASE_URL}/backend-api/conversation/${conversationId}`,
    method: 'PATCH',
    headers: {
      ...baseHeaders(token, meta, `/backend-api/conversation/${conversationId}`),
      accept: '*/*',
      'content-type': 'application/json',
      referer: `${BASE_URL}/c/${conversationId}`,
    },
    body: { is_visible: false },
  });
}

export async function deleteFile(token: string, meta: ChatGptAccountMeta, fileId: string): Promise<void> {
  if (!fileId) return;
  await tlsText({
    url: `${BASE_URL}/backend-api/files/${fileId}`,
    method: 'DELETE',
    headers: {
      ...baseHeaders(token, meta, `/backend-api/files/${fileId}`),
      accept: '*/*',
      referer: `${BASE_URL}/`,
    },
  });
}

export async function downloadFileText(
  token: string,
  meta: ChatGptAccountMeta,
  fileId: string,
): Promise<string | undefined> {
  const totalStarted = Date.now();
  const getUrlStarted = Date.now();
  const data = await tlsJson<Record<string, unknown>>({
    url: `${BASE_URL}/backend-api/files/${fileId}/download`,
    method: 'GET',
    headers: {
      ...baseHeaders(token, meta, `/backend-api/files/${fileId}/download`),
      accept: 'application/json',
      referer: `${BASE_URL}/`,
    },
  });
  trace(meta, 'download.get_url', Date.now() - getUrlStarted, { fileId });
  const url = stringValue(data.download_url) || stringValue(data.url);
  if (!url) return undefined;
  const fetchStarted = Date.now();
  try {
    return await tlsText({
      url,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': acceptLanguage(meta.language),
        'user-agent': meta.userAgent,
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        ...(meta.cookie ? { cookie: meta.cookie } : {}),
      },
    });
  } finally {
    trace(meta, 'download.fetch_content', Date.now() - fetchStarted, { fileId });
    trace(meta, 'download.total', Date.now() - totalStarted, { fileId });
  }
}

export function makeUserMessage(content: string, attachments: UploadedFile[] = []): ChatGptMessage {
  return {
    id: randomUUID(),
    author: { role: 'user' },
    create_time: Date.now() / 1000,
    content: { content_type: 'text', parts: [content] },
    metadata: {
      ...(attachments.length
        ? {
            attachments: attachments.map((file) => ({
              id: file.fileId,
              size: file.size,
              name: file.fileName,
              file_token_size: Math.max(1, Math.ceil(file.size / 4)),
              source: 'library',
              is_big_paste: false,
            })),
          }
        : {}),
      developer_mode_connector_ids: [],
      selected_sources: [],
      selected_github_repos: [],
      selected_all_github_repos: false,
      serialization_metadata: { custom_symbol_offsets: [] },
    },
  };
}

export function parseSseLine(line: string, state?: SseParseState): ParsedStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('event:')) return undefined;
  if (!trimmed.startsWith('data:')) return undefined;
  const raw = trimmed.slice(5).trim();
  if (!raw) return undefined;
  if (raw === '[DONE]') return { done: true, finishReason: 'stop' };

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== 'object') return undefined;
  const obj = event as Record<string, unknown>;
  const conversationId = extractConversationId(obj);
  const assistantMessageId = extractAssistantMessageId(obj);
  const error = extractError(obj);

  if (state && obj.type === 'message_marker' && obj.marker === 'final_channel_token' && assistantMessageId) {
    state.activeFinalMessageId = assistantMessageId;
  }
  if (state && obj.type === 'message_marker' && obj.marker === 'last_token') {
    state.activeFinalMessageId = undefined;
  }

  if (obj.type === 'resume_conversation_token' || obj.type === 'message_stream_complete') {
    return { conversationId, assistantMessageId };
  }

  const textDelta = extractTextDelta(obj, state);
  const reasoningDelta = extractReasoningDelta(obj, state);
  if (textDelta && state) state.sawAssistantContent = true;
  const finishReason = extractFinishReason(obj);
  if (textDelta || reasoningDelta || conversationId || assistantMessageId || finishReason || error) {
    return { textDelta, reasoningDelta, conversationId, assistantMessageId, finishReason, error };
  }
  return undefined;
}

function buildConversationPayload(request: ConversationRequest, meta: ChatGptAccountMeta): Record<string, unknown> {
  return {
    action: 'next',
    messages: request.messages,
    ...(request.conversationId ? { conversation_id: request.conversationId } : {}),
    parent_message_id: request.parentMessageId || 'client-created-root',
    model: request.model,
    client_prepare_state: 'success',
    timezone_offset_min: -420,
    timezone: 'Asia/Saigon',
    conversation_mode: { kind: 'primary_assistant' },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    client_contextual_info: {
      is_dark_mode: true,
      time_since_loaded: Math.floor(1000 + Math.random() * 20000),
      page_height: 1066,
      page_width: 1459,
      pixel_ratio: 1.75,
      screen_height: 1235,
      screen_width: 2195,
      app_name: 'chatgpt.com',
    },
    paragen_cot_summary_display_override: 'allow',
    force_parallel_switch: 'auto',
    force_use_sse: true,
    ...(request.thinking ? chatGptThinkingPayload(request.reasoningEffort) : {}),
    language: meta.language,
  };
}

function chatGptThinkingPayload(reasoningEffort?: string): Record<string, unknown> {
  const normalized = reasoningEffort
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'high' || normalized === 'extra_high' || normalized === 'xhigh') {
    return { thinking_effort: 'extended' };
  }
  return {};
}

async function getChatRequirements(token: string, meta: ChatGptAccountMeta): Promise<ChatRequirements> {
  const totalStarted = Date.now();
  const bootStarted = Date.now();
  const boot = await tlsText({
    url: `${BASE_URL}/`,
    method: 'GET',
    headers: {
      'user-agent': meta.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': acceptLanguage(meta.language),
      'sec-ch-ua': meta.secChUa,
      'sec-ch-ua-mobile': meta.secChUaMobile,
      'sec-ch-ua-platform': meta.secChUaPlatform,
      ...(meta.cookie ? { cookie: meta.cookie } : {}),
    },
  });
  trace(meta, 'requirements.boot', Date.now() - bootStarted);
  const parseStarted = Date.now();
  const { scriptSources, dataBuild } = parsePowResources(boot);
  const sourceP = buildLegacyRequirementsToken(meta.userAgent, scriptSources, dataBuild);
  trace(meta, 'requirements.build_p', Date.now() - parseStarted, {
    scripts: scriptSources.length,
    build: dataBuild || '<none>',
  });
  const apiStarted = Date.now();
  const data = await tlsJson<Record<string, unknown>>({
    url: `${BASE_URL}/backend-api/sentinel/chat-requirements`,
    method: 'POST',
    headers: {
      ...baseHeaders(token, meta, '/backend-api/sentinel/chat-requirements'),
      'content-type': 'application/json',
      accept: '*/*',
    },
    body: { p: sourceP },
  });
  trace(meta, 'requirements.api', Date.now() - apiStarted, {
    powRequired: objectValue(data.proofofwork).required === true,
    turnstileRequired: objectValue(data.turnstile).required === true,
  });

  const proofInfo = objectValue(data.proofofwork);
  const proofStarted = Date.now();
  const proofToken =
    proofInfo.required === true
      ? buildProofToken(
          String(proofInfo.seed || ''),
          String(proofInfo.difficulty || ''),
          meta.userAgent,
          scriptSources,
          dataBuild,
        )
      : undefined;
  if (proofInfo.required === true) {
    trace(meta, 'requirements.proof_token', Date.now() - proofStarted, {
      difficulty: String(proofInfo.difficulty || ''),
    });
  }
  const turnstileInfo = objectValue(data.turnstile);
  const turnstileStarted = Date.now();
  const turnstileToken =
    turnstileInfo.required === true && typeof turnstileInfo.dx === 'string'
      ? solveTurnstileToken(turnstileInfo.dx, sourceP)
      : undefined;
  if (turnstileInfo.required === true) {
    trace(meta, 'requirements.turnstile_token', Date.now() - turnstileStarted);
  }

  const requirementsToken = stringValue(data.token);
  if (!requirementsToken)
    throw new Error(`ChatGPT missing chat requirements token: ${JSON.stringify(data).slice(0, 500)}`);
  trace(meta, 'requirements.total', Date.now() - totalStarted);
  return {
    token: requirementsToken,
    proofToken,
    turnstileToken,
    soToken: stringValue(data.so_token) || undefined,
  };
}

function baseHeaders(token: string, meta: ChatGptAccountMeta, targetPath: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'user-agent': meta.userAgent,
    'accept-language': acceptLanguage(meta.language),
    origin: BASE_URL,
    referer: `${BASE_URL}/`,
    priority: 'u=1, i',
    'sec-ch-ua': meta.secChUa,
    'sec-ch-ua-mobile': meta.secChUaMobile,
    'sec-ch-ua-platform': meta.secChUaPlatform,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'oai-client-build-number': meta.clientBuildNumber,
    'oai-client-version': meta.clientVersion,
    'oai-device-id': meta.deviceId,
    'oai-language': meta.language,
    'oai-session-id': meta.sessionId,
    'x-openai-target-path': targetPath,
    'x-openai-target-route': targetPath,
    ...(meta.xOaiIs ? { 'x-oai-is': meta.xOaiIs } : {}),
    ...(meta.cookie ? { cookie: meta.cookie } : {}),
  };
}

function extractTextDelta(event: Record<string, unknown>, state?: SseParseState): string | undefined {
  updateContentType(event, state);
  if (typeof event.v === 'string' && !event.p) {
    return !state || state.currentContentType !== 'reasoning' || state.activeFinalMessageId || state.sawAssistantContent
      ? event.v
      : undefined;
  }
  if (typeof event.v === 'string' && event.p !== '/message/content/parts/0') return undefined;
  if (event.p === '/message/content/parts/0' && (event.o === 'append' || event.o === 'replace')) {
    return typeof event.v === 'string' ? event.v : undefined;
  }
  if (event.o === 'patch' && Array.isArray(event.v)) {
    return (
      event.v
        .map((item) => extractTextDelta(objectValue(item), state))
        .filter(Boolean)
        .join('') || undefined
    );
  }
  if (Array.isArray(event.v)) {
    return (
      event.v
        .map((item) => extractTextDelta(objectValue(item), state))
        .filter(Boolean)
        .join('') || undefined
    );
  }
  return undefined;
}

function extractReasoningDelta(event: Record<string, unknown>, state?: SseParseState): string | undefined {
  updateContentType(event, state);
  if (typeof event.v === 'string' && !event.p && state?.currentContentType === 'reasoning') return event.v;
  const path = typeof event.p === 'string' ? event.p : '';
  if (typeof event.v === 'string' && isReasoningPath(path)) return event.v;
  if (event.o === 'patch' && Array.isArray(event.v)) {
    return (
      event.v
        .map((item) => extractReasoningDelta(objectValue(item), state))
        .filter(Boolean)
        .join('') || undefined
    );
  }
  if (Array.isArray(event.v)) {
    return (
      event.v
        .map((item) => extractReasoningDelta(objectValue(item), state))
        .filter(Boolean)
        .join('') || undefined
    );
  }
  return undefined;
}

function updateContentType(event: Record<string, unknown>, state?: SseParseState): void {
  if (!state) return;
  const message = objectValue(objectValue(event.v).message);
  const content = objectValue(message.content);
  const contentType = stringValue(content.content_type);
  if (contentType.includes('model_editable_context') || contentType.includes('reasoning')) {
    state.currentContentType = 'reasoning';
  } else if (message.channel === 'final' || contentType === 'text') {
    state.currentContentType = 'text';
  }
}

function isReasoningPath(path: string): boolean {
  return path.includes('thinking') || path.includes('reasoning') || path.includes('model_editable_context');
}

function extractConversationId(event: Record<string, unknown>): string | undefined {
  if (typeof event.conversation_id === 'string') return event.conversation_id;
  const v = objectValue(event.v);
  if (typeof v.conversation_id === 'string') return v.conversation_id;
  return undefined;
}

function extractAssistantMessageId(event: Record<string, unknown>): string | undefined {
  if (
    event.type === 'message_marker' &&
    (event.marker === 'final_channel_token' || event.marker === 'last_token') &&
    typeof event.message_id === 'string'
  ) {
    return event.message_id;
  }
  const message = objectValue(objectValue(event.v).message);
  if (
    objectValue(message.author).role === 'assistant' &&
    message.channel === 'final' &&
    typeof message.id === 'string'
  ) {
    return message.id;
  }
  return undefined;
}

function extractFinishReason(event: Record<string, unknown>): string | undefined {
  if (event.done === true) return 'stop';
  if (event.type === 'message_stream_complete') return 'stop';
  if (event.o === 'patch' && Array.isArray(event.v)) {
    for (const item of event.v) {
      const patch = objectValue(item);
      if (patch.p === '/message/status' && patch.v === 'finished_successfully') return 'stop';
    }
  }
  return undefined;
}

function extractError(event: Record<string, unknown>): string | undefined {
  if (typeof event.error === 'string') return event.error;
  if (typeof event.error_code === 'string') return event.error_code;
  if (event.type === 'error') return JSON.stringify(event).slice(0, 500);
  const v = objectValue(event.v);
  if (typeof v.error === 'string') return v.error;
  if (typeof v.error_code === 'string') return v.error_code;
  const err = objectValue(v.error);
  return stringValue(err.message) || stringValue(err.code) || undefined;
}

async function ensureTls(): Promise<void> {
  if (!initPromise) {
    initPromise = initTLS().catch((err: unknown) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

async function tlsJson<T>(options: TlsRequestOptions): Promise<T> {
  const text = await tlsText(options);
  return JSON.parse(text) as T;
}

async function tlsText(options: TlsRequestOptions): Promise<string> {
  const response = await tlsRequest(options);
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `ChatGPT ${options.method} ${shortEndpoint(options.url)} failed: HTTP ${response.status} ${text.slice(0, 500)}`,
    );
  return text;
}

interface TlsRequestOptions {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
  onCookieHeader?: (cookie: string) => void;
}

interface TlsResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

async function tlsRequest(options: TlsRequestOptions): Promise<TlsResponseLike> {
  return withRetry(async () => tlsRequestOnce(options), options);
}

async function tlsRequestOnce(options: TlsRequestOptions): Promise<TlsResponseLike> {
  await ensureTls();
  const session = createTlsSession();
  try {
    const requestOptions: Record<string, unknown> = {
      headers: options.headers,
      body: options.rawBody || JSON.stringify(options.body),
    };
    if (options.method === 'GET') return session.get(options.url, { headers: options.headers });
    if (options.method === 'DELETE')
      return (session as unknown as { delete: (url: string, options: unknown) => Promise<TlsResponseLike> }).delete(
        options.url,
        { headers: options.headers },
      );
    if (options.method === 'PUT') return session.put(options.url, requestOptions);
    if (options.method === 'PATCH')
      return (session as unknown as { patch: (url: string, options: unknown) => Promise<TlsResponseLike> }).patch(
        options.url,
        requestOptions,
      );
    return session.post(options.url, requestOptions);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function withRetry<T extends { ok?: boolean; status?: number }>(
  fn: () => Promise<T>,
  options: Pick<TlsRequestOptions, 'url' | 'method' | 'headers'>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, RETRY_ATTEMPTS); attempt++) {
    try {
      const response = await fn();
      if (!isRetryableStatus(response.status) || attempt >= RETRY_ATTEMPTS) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
      if (attempt >= RETRY_ATTEMPTS) throw err;
    }
    const delay = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    console.warn(
      `[CHATGPT] retry ${attempt}/${RETRY_ATTEMPTS} ${options.method} ${shortEndpoint(options.url)} after ${delay}ms: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (!!status && status >= 500);
}

async function* tlsStreamLines(options: TlsRequestOptions, signal?: AbortSignal): AsyncGenerator<string> {
  await ensureTls();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmweb2api-chatgpt-'));
  const streamOutputPath = path.join(tempDir, 'stream.sse');
  await fs.writeFile(streamOutputPath, '');
  const session = new Session({
    ...tlsSessionConfig(),
    streamOutputPath,
    streamOutputBlockSize: 1,
    streamOutputEOFSymbol: STREAM_EOF,
  });
  patchCookieSync(session);

  let settled = false;
  let requestError: unknown;
  let response: TlsResponseLike | undefined;
  const requestPromise = session
    .post(options.url, { headers: options.headers, body: JSON.stringify(options.body) })
    .then((resp: TlsResponseLike) => {
      response = resp;
    })
    .catch((err: unknown) => {
      requestError = err;
    })
    .finally(() => {
      settled = true;
    });

  let offset = 0;
  let pending = '';
  const decoder = new TextDecoder();
  try {
    while (!settled || offset < (await fileSize(streamOutputPath))) {
      if (signal?.aborted) return;
      const bytes = await readNewBytes(streamOutputPath, offset);
      if (bytes.length > 0) {
        offset += bytes.length;
        pending += decoder.decode(bytes, { stream: true }).replaceAll(STREAM_EOF, '');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) yield line;
      } else if (!settled) {
        await sleep(STREAM_POLL_MS);
      }
    }
    await requestPromise;
    if (pending.trim()) yield pending;
    if (requestError) throw requestError;
    if (!response) throw new Error('ChatGPT stream failed: no response');
    if (!response.ok)
      throw new Error(`ChatGPT stream failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  } finally {
    await requestPromise.catch(() => undefined);
    const cookieHeader = await cookieHeaderFromSession(session);
    if (cookieHeader) options.onCookieHeader?.(cookieHeader);
    await session.close().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function cookieHeaderFromSession(session: Session): Promise<string> {
  try {
    const cookies = (await session.cookies()) as Array<{ key?: string; value?: string }>;
    return cookies
      .filter((cookie) => cookie.key && cookie.value !== undefined)
      .map((cookie) => `${cookie.key}=${cookie.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

function mergeCookieHeaders(existing = '', incoming = ''): string {
  const merged = new Map<string, string>();
  for (const header of [existing, incoming]) {
    for (const item of header.split(';')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      merged.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  return [...merged].map(([key, value]) => `${key}=${value}`).join('; ');
}

function createTlsSession(): Session {
  const session = new Session(tlsSessionConfig());
  patchCookieSync(session);
  return session;
}

function tlsSessionConfig(): ConstructorParameters<typeof Session>[0] {
  return {
    clientIdentifier: ClientIdentifier.chrome_124,
    timeout: TIMEOUT_MS,
    insecureSkipVerify: false,
    randomTlsExtensionOrder: true,
  };
}

function patchCookieSync(session: Session): void {
  const jar = (
    session as unknown as {
      jar?: {
        setCookie: (cookie: string, url: string) => Promise<{ key: string; value: string } | undefined>;
        syncCookies?: unknown;
      };
    }
  ).jar;
  if (!jar || typeof jar.syncCookies !== 'function') return;
  jar.syncCookies = async (
    cookies: Record<string, string> | undefined,
    url: string,
  ): Promise<Record<string, string>> => {
    if (!cookies) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(cookies)) {
      try {
        const cookie = await jar.setCookie(`${key}=${value}`, url);
        if (cookie?.key) result[cookie.key] = cookie.value;
      } catch {
        continue;
      }
    }
    return result;
  };
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function readNewBytes(filePath: string, offset: number): Promise<Buffer> {
  try {
    return (await fs.readFile(filePath)).subarray(offset);
  } catch {
    return Buffer.alloc(0);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function trace(meta: ChatGptAccountMeta, label: string, ms: number, details?: Record<string, unknown>): void {
  meta.trace?.(label, ms, details);
}

function acceptLanguage(language: string): string {
  return language === 'vi-VN' ? 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' : `${language},en-US;q=0.8,en;q=0.7`;
}

function shortEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
