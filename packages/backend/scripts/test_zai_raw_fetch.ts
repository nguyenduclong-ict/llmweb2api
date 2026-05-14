import fs from 'fs';
import path from 'path';

type BrowserFetchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const DEFAULT_INPUT = path.resolve(process.cwd(), '../../tmp/zai_raw_fetch.txt');

async function main(): Promise<void> {
  const inputPath = path.resolve(getArg('--input') ?? DEFAULT_INPUT);
  const maxChunks = Number(getArg('--max-chunks') ?? '20');
  const timeoutMs = Number(getArg('--timeout-ms') ?? '120000');
  const all = process.argv.includes('--all');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const source = fs.readFileSync(inputPath, 'utf8');
  const requests = all ? parseBrowserFetches(source) : [parseBrowserFetch(source)];

  for (let i = 0; i < requests.length; i++) {
    await sendRequest(requests[i], {
      index: i + 1,
      total: requests.length,
      maxChunks,
      timeoutMs,
    });
  }
}

async function sendRequest(
  req: BrowserFetchRequest,
  options: { index: number; total: number; maxChunks: number; timeoutMs: number },
): Promise<void> {
  console.log(`[ZAI_RAW ${options.index}/${options.total}] url=${req.url.slice(0, 140)}...`);
  console.log(`[ZAI_RAW ${options.index}/${options.total}] method=${req.method} bodyChars=${req.body?.length ?? 0}`);
  console.log(`[ZAI_RAW ${options.index}/${options.total}] headers=${Object.keys(req.headers).sort().join(', ')}`);
  console.log(
    `[ZAI_RAW ${options.index}/${options.total}] captcha=${req.body?.includes('captcha_verify_param') ? 'yes' : 'no'}`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      body: req.body,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '<none>';
    console.log(`[ZAI_RAW ${options.index}/${options.total}] status=${response.status} ${response.statusText}`);
    console.log(`[ZAI_RAW ${options.index}/${options.total}] content-type=${contentType}`);

    if (!response.ok || !response.body || contentType.includes('application/json')) {
      console.log((await response.text()).slice(0, 4000));
      return;
    }

    await readStream(response.body, options.maxChunks);
  } finally {
    clearTimeout(timer);
  }
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseBrowserFetch(source: string): BrowserFetchRequest {
  const requests = parseBrowserFetches(source);
  if (requests.length === 0) throw new Error('Input does not contain fetch(...)');
  return requests[0];
}

function parseBrowserFetches(source: string): BrowserFetchRequest[] {
  const trimmed = source.trim();
  const requests: BrowserFetchRequest[] = [];
  let searchStart = 0;

  while (true) {
    const fetchStart = trimmed.indexOf('fetch(', searchStart);
    if (fetchStart < 0) break;

    const urlStart = trimmed.indexOf('"', fetchStart);
    if (urlStart < 0) throw new Error('Cannot find fetch URL opening quote');
    const urlEnd = findStringEnd(trimmed, urlStart);
    const url = JSON.parse(trimmed.slice(urlStart, urlEnd + 1)) as string;

    const optionsStart = trimmed.indexOf('{', urlEnd);
    if (optionsStart < 0) throw new Error('Cannot find fetch options object');
    const optionsEnd = findMatchingBrace(trimmed, optionsStart);
    const options = JSON.parse(trimmed.slice(optionsStart, optionsEnd + 1)) as {
      headers?: Record<string, string>;
      body?: string;
      method?: string;
    };

    requests.push({
      url,
      method: options.method ?? 'POST',
      headers: options.headers ?? {},
      body: options.body,
    });
    searchStart = optionsEnd + 1;
  }

  return requests;
}

function findStringEnd(value: string, start: number): number {
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === '"') return i;
  }
  throw new Error('Unterminated string literal');
}

function findMatchingBrace(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < value.length; i++) {
    const char = value[i];
    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unterminated object literal');
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set(['host', 'connection', 'content-length']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

async function readStream(body: ReadableStream<Uint8Array>, maxChunks: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let chunks = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      const part = decoder.decode(value, { stream: true });
      text += part;
      console.log(`[ZAI_RAW] chunk ${chunks} bytes=${value.byteLength}`);
      console.log(part.slice(0, 4000));
      if (chunks >= maxChunks) {
        console.log(`[ZAI_RAW] max chunks reached (${maxChunks}), cancelling reader`);
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  console.log(`[ZAI_RAW] totalChars=${text.length}`);
}

main().catch((err) => {
  console.error(`[ZAI_RAW] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exitCode = 1;
});
