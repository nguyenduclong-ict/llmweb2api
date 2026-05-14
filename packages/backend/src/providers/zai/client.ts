import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  ZAI_BASE_URL,
  ZAI_DEFAULT_LANGUAGE,
  ZAI_DEFAULT_TIMEZONE,
  ZAI_DEFAULT_TITLE,
  ZAI_FE_VERSION,
  ZAI_SIGNATURE_SECRET,
  ZAI_SIGNATURE_WINDOW_MS,
  ZAI_USER_AGENT,
} from './constants';
import type { ZaiCreateChatResult, ZaiStreamEvent, ZaiStreamInput } from './types';

export function extractUserIdFromToken(token: string): string {
  if (!token || token.split('.').length !== 3) throw new Error('Invalid Z.ai JWT token');
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1])) as Record<string, unknown>;
    const userId = payload.id ?? payload.user_id ?? payload.uid ?? payload.sub;
    if (typeof userId !== 'string' && typeof userId !== 'number') {
      throw new Error('Missing user id in Z.ai JWT token');
    }
    const value = String(userId).trim();
    if (!value) throw new Error('Missing user id in Z.ai JWT token');
    return value;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Z.ai JWT')) throw err;
    throw new Error('Invalid Z.ai JWT token', { cause: err });
  }
}

export function generateSignature(input: {
  messageText: string;
  requestId: string;
  timestampMs: number;
  userId: string;
}): string {
  const metadata = `requestId,${input.requestId},timestamp,${input.timestampMs},user_id,${input.userId}`;
  const base64Message = Buffer.from(input.messageText, 'utf8').toString('base64');
  const canonical = `${metadata}|${base64Message}|${input.timestampMs}`;
  const windowIndex = Math.floor(input.timestampMs / ZAI_SIGNATURE_WINDOW_MS);
  const derivedKeyHex = crypto.createHmac('sha256', ZAI_SIGNATURE_SECRET).update(String(windowIndex)).digest('hex');
  return crypto.createHmac('sha256', derivedKeyHex).update(canonical).digest('hex');
}

export function createMessageId(): string {
  return randomUUID();
}

export async function createChat(
  token: string,
  model: string,
  firstMessageContent: string,
): Promise<ZaiCreateChatResult> {
  const messageId = createMessageId();
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${ZAI_BASE_URL}/api/v1/chats/new`, {
    method: 'POST',
    headers: buildBrowserHeaders(token),
    body: JSON.stringify({
      chat: {
        id: '',
        title: 'New Chat',
        models: [model],
        params: {},
        history: {
          messages: {
            [messageId]: {
              id: messageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: firstMessageContent,
              timestamp,
              models: [model],
            },
          },
          currentId: messageId,
        },
        tags: [],
        flags: [],
        features: [{ type: 'tool_selector', server: 'tool_selector_h', status: 'hidden' }],
        mcp_servers: [],
        enable_thinking: true,
        auto_web_search: true,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Z.ai create chat failed HTTP ${response.status}: ${raw.slice(0, 800)}`);
  const data = parseJson(raw);
  const chatId =
    stringFromPath(data, ['id']) ?? stringFromPath(data, ['data', 'id']) ?? stringFromPath(data, ['chat', 'id']);
  if (!chatId) throw new Error(`Z.ai create chat failed: missing id in ${raw.slice(0, 800)}`);
  return { chatId, messageId };
}

export async function* streamChatCompletion(input: ZaiStreamInput): AsyncGenerator<ZaiStreamEvent> {
  const timestampMs = Date.now();
  const signature = generateSignature({
    messageText: input.signaturePrompt,
    requestId: input.requestId,
    timestampMs,
    userId: input.userId,
  });
  const url = `${ZAI_BASE_URL}/api/v2/chat/completions?${buildFingerprintQuery({
    token: input.token,
    chatId: input.chatId,
    requestId: input.requestId,
    userId: input.userId,
    timestampMs,
  })}`;
  const bodyObj = {
    stream: true,
    model: input.model,
    messages: input.messages,
    signature_prompt: input.signaturePrompt,
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: input.autoWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: input.enableThinking,
    },
    variables: {
      '{{USER_NAME}}': 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
      '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
      '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
      '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
        new Date().getDay()
      ],
      '{{CURRENT_TIMEZONE}}': 'UTC',
      '{{USER_LANGUAGE}}': 'en-US',
    },
    chat_id: input.chatId,
    id: input.requestId,
    current_user_message_id: input.messageId,
    current_user_message_parent_id: input.parentMessageId,
    ...(input.captchaVerifyParam ? { captcha_verify_param: input.captchaVerifyParam } : {}),
    background_tasks: {
      title_generation: true,
      tags_generation: true,
    },
  };
  console.log('bodyObj', bodyObj);
  const body = JSON.stringify(bodyObj);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildBrowserHeaders(input.token, input.chatId, signature),
    body,
    signal: input.signal,
  });

  if (input.signal?.aborted) return;
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`Z.ai completion failed HTTP ${response.status}: ${text.slice(0, 800)}`);
  }

  for await (const payload of parseSse(response.body, input.signal)) {
    if (payload === '[DONE]') {
      yield { phase: 'done', done: true };
      continue;
    }
    const parsed = parseJson(payload) as Record<string, unknown>;
    const event = toStreamEvent(parsed);
    if (event) yield event;
  }
}

export async function deleteChat(token: string, chatId: string): Promise<void> {
  if (!chatId) return;
  const response = await fetch(`${ZAI_BASE_URL}/api/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    headers: buildBrowserHeaders(token, chatId),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Z.ai delete chat failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

export function buildBrowserHeaders(token: string, chatId?: string, signature?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Cookie: `token=${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN',
    Origin: ZAI_BASE_URL,
    Referer: chatId ? `${ZAI_BASE_URL}/c/${chatId}` : `${ZAI_BASE_URL}/`,
    'User-Agent': ZAI_USER_AGENT,
    'X-FE-Version': ZAI_FE_VERSION,
    ...(signature ? { 'X-Signature': signature } : {}),
    'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Priority: 'u=1, i',
  };
}

function buildFingerprintQuery(input: {
  token: string;
  chatId: string;
  requestId: string;
  userId: string;
  timestampMs: number;
}): string {
  const params = new URLSearchParams({
    timestamp: String(input.timestampMs),
    requestId: input.requestId,
    user_id: input.userId,
    version: '0.0.1',
    platform: 'web',
    token: input.token,
    user_agent: ZAI_USER_AGENT,
    language: ZAI_DEFAULT_LANGUAGE,
    languages: 'zh-CN,zh',
    timezone: ZAI_DEFAULT_TIMEZONE,
    cookie_enabled: 'true',
    screen_width: '1512',
    screen_height: '982',
    screen_resolution: '1512x982',
    viewport_height: '945',
    viewport_width: '923',
    viewport_size: '923x945',
    color_depth: '30',
    pixel_ratio: '2',
    current_url: `${ZAI_BASE_URL}/c/${input.chatId}`,
    pathname: `/c/${input.chatId}`,
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: '',
    title: ZAI_DEFAULT_TITLE,
    timezone_offset: '-480',
    local_time: new Date().toISOString(),
    utc_time: new Date().toUTCString(),
    is_mobile: 'false',
    is_touch: 'false',
    max_touch_points: '0',
    browser_name: 'Chrome',
    os_name: 'Mac OS',
    signature_timestamp: String(input.timestampMs),
  });
  return params.toString();
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: { index: number; length: number } | undefined;
      while ((boundary = findSseBoundary(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0) return { index: lf, length: 2 };
  return crlf < lf ? { index: crlf, length: 4 } : { index: lf, length: 2 };
}

function toStreamEvent(parsed: Record<string, unknown>): ZaiStreamEvent | null {
  const rootError = extractError(parsed);
  if (rootError) return { error: rootError, raw: parsed };
  const data = objectValue(parsed.data) ?? parsed;
  const dataError = extractError(data);
  if (dataError) return { error: dataError, raw: parsed };

  const phase = stringValue(data.phase) as ZaiStreamEvent['phase'] | undefined;
  const id = stringValue(data.id) ?? stringValue(data.message_id) ?? stringValue(data.response_message_id);
  const delta = stringValue(data.delta_content) ?? stringValue(data.delta) ?? stringValue(data.content) ?? '';
  const done = data.done === true || phase === 'done' || data.finish_reason === 'stop';
  const usage = objectValue(data.usage);
  return {
    id,
    phase: phase === 'thinking' || phase === 'answer' || phase === 'done' ? phase : delta ? 'answer' : undefined,
    delta,
    done,
    usage: usage
      ? {
          promptTokens: numberValue(usage.prompt_tokens),
          completionTokens: numberValue(usage.completion_tokens),
          totalTokens: numberValue(usage.total_tokens),
        }
      : undefined,
    raw: parsed,
  };
}

function base64UrlDecode(value: string): string {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid Z.ai JSON: ${value.slice(0, 500)}`);
  }
}

function stringFromPath(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    const object = objectValue(current);
    if (!object) return undefined;
    current = object[key];
  }
  return stringValue(current);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractError(value: Record<string, unknown>): string | undefined {
  if (typeof value.error === 'string') return value.error;
  if (value.error) return JSON.stringify(value.error).slice(0, 500);
  return undefined;
}
