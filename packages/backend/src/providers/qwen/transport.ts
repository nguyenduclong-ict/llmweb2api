import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClientIdentifier, Session, initTLS } from 'node-tls-client';
import { QWEN_BASE_URL } from './types';

const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = Number(process.env.QWEN_TLS_TIMEOUT_MS || 120000);
const STREAM_POLL_MS = Number(process.env.QWEN_TLS_STREAM_POLL_MS || 25);
const STREAM_EOF = '__LLMWEB2API_QWEN_STREAM_EOF__';

let initPromise: Promise<void> | null = null;

interface TlsResponseLike {
  ok: boolean;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface QwenTlsRequestOptions {
  token: string;
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  referer?: string;
  accept?: string;
  body?: unknown;
}

async function ensureTls(): Promise<void> {
  if (!initPromise) {
    initPromise = initTLS().catch((err: unknown) => {
      initPromise = null;
      throw new Error(`Qwen TLS transport initialization failed: ${errorMessage(err)}`);
    });
  }
  await initPromise;
}

function createSession(streamOutputPath?: string): Session {
  return new Session({
    clientIdentifier: ClientIdentifier.chrome_124,
    timeout: DEFAULT_TIMEOUT_MS,
    insecureSkipVerify: false,
    randomTlsExtensionOrder: true,
    streamOutputPath,
    streamOutputBlockSize: streamOutputPath ? 1 : undefined,
    streamOutputEOFSymbol: streamOutputPath ? STREAM_EOF : undefined,
  });
}

function buildHeaders(options: QwenTlsRequestOptions): Record<string, string | string[] | undefined> {
  return {
    authorization: `Bearer ${options.token}`,
    'user-agent': WEB_USER_AGENT,
    accept: options.accept || 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: options.referer || `${QWEN_BASE_URL}/`,
    origin: QWEN_BASE_URL,
    connection: 'keep-alive',
    'content-type': 'application/json',
  };
}

const HEADER_ORDER: string[] = [
  'authorization',
  'user-agent',
  'accept',
  'accept-language',
  'referer',
  'origin',
  'connection',
  'content-type',
];

export async function qwenTlsJson<T>(options: QwenTlsRequestOptions): Promise<T> {
  const response = await qwenTlsRequest(options);
  const text = await response.text();
  const parsed = safeJson<T>(text);
  if (!response.ok) {
    throw new Error(
      `Qwen ${options.method || 'POST'} ${shortEndpoint(options.url)} failed: HTTP ${response.status} ${redact(text)}`,
    );
  }
  if (parsed === undefined) {
    throw new Error(
      `Qwen ${options.method || 'POST'} ${shortEndpoint(options.url)} returned non-JSON body: ${redact(text)}`,
    );
  }
  return parsed;
}

export async function qwenTlsRequest(options: QwenTlsRequestOptions): Promise<TlsResponseLike> {
  await ensureTls();
  const session = createSession();
  try {
    const response = await execute(session, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Qwen ${options.method || 'POST'} ${shortEndpoint(options.url)} failed: HTTP ${response.status} ${redact(text)}`,
      );
    }
    return response;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Qwen ')) throw err;
    throw new Error(`Qwen TLS request failed for ${shortEndpoint(options.url)}: ${errorMessage(err)}`, { cause: err });
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function* qwenTlsStreamLines(
  options: QwenTlsRequestOptions,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  await ensureTls();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmweb2api-qwen-'));
  const streamOutputPath = path.join(tempDir, 'stream.sse');
  await fs.writeFile(streamOutputPath, '');

  const session = createSession(streamOutputPath);
  let settled = false;
  let response: TlsResponseLike | undefined;
  let requestError: unknown;
  const requestPromise = execute(session, options)
    .then((resp) => {
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
  let sawAnyLine = false;
  const decoder = new TextDecoder();

  try {
    while (!settled || offset < (await fileSize(streamOutputPath))) {
      if (signal?.aborted) return;

      const bytes = await readNewBytes(streamOutputPath, offset);
      if (bytes.length > 0) {
        offset += bytes.length;
        pending += decoder.decode(bytes, { stream: true });
        pending = pending.replaceAll(STREAM_EOF, '');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          sawAnyLine = true;
          yield line;
        }
      } else if (!settled) {
        await sleep(STREAM_POLL_MS);
      }
    }

    await requestPromise;
    const tail = decoder.decode();
    if (tail) pending += tail;
    pending = pending.replaceAll(STREAM_EOF, '');
    if (pending.trim()) {
      sawAnyLine = true;
      yield pending;
    }

    if (requestError) {
      throw new Error(`Qwen TLS stream failed for ${shortEndpoint(options.url)}: ${errorMessage(requestError)}`);
    }

    if (!response) {
      throw new Error(`Qwen TLS stream failed for ${shortEndpoint(options.url)}: no response`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Qwen stream failed: HTTP ${response.status} ${redact(text)}`);
    }

    if (!sawAnyLine) {
      const text = await response.text().catch(() => '');
      throw new Error(`Qwen stream produced no realtime output: ${redact(text)}`);
    }
  } finally {
    await requestPromise.catch(() => undefined);
    await session.close().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execute(session: Session, options: QwenTlsRequestOptions): Promise<TlsResponseLike> {
  const headers = buildHeaders(options);
  const method = options.method || 'POST';
  const baseOpts: Record<string, unknown> = { headers, headerOrder: HEADER_ORDER };
  if (method === 'DELETE') {
    return session.delete(options.url, baseOpts as any);
  }
  baseOpts.body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const requestOptions = baseOpts as any;
  if (method === 'GET') return session.get(options.url, requestOptions);
  return session.post(options.url, requestOptions);
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
    const bytes = await fs.readFile(filePath);
    return bytes.subarray(offset);
  } catch {
    return Buffer.alloc(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function shortEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function redact(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>').slice(0, 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
