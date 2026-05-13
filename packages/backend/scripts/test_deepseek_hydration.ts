import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import * as client from '../src/providers/deepseek/client';
import { HYDRATION_REMEMBER_PROMPT } from '../src/providers/deepseek/constants';
import type { DeepSeekCompletionPayload } from '../src/providers/deepseek/types';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

type CancelMode = 'first-line' | 'message-id' | 'content' | 'none';

type Args = {
  token?: string;
  contextPath: string;
  chunkChars: number;
  chunkTokens?: number;
  maxChunks?: number;
  cancelMode: CancelMode;
  modelType: string;
  raw: boolean;
  keepSession: boolean;
  stopOnCancel: boolean;
  delayBeforeCancelMs: number;
  delayAfterCancelMs: number;
  delayBetweenChunksMs: number;
  summaryPrompt: string;
};

type CompletionResult = {
  text: string;
  reasoning: string;
  lineCount: number;
  parsedCount: number;
  requestMessageId?: number;
  responseMessageId?: number;
  stopped: boolean;
};

const DEFAULT_CONTEXT_PATH = path.resolve(__dirname, '../../..', 'tmp/crawl4ai_custom_context.md');
const TOKEN_CACHE_PATH = path.resolve(__dirname, '../../..', 'tmp/deepseek_token_cache.json');
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_PROMPT =
  'Summarize all context chunks previously sent in this chat session. Focus on concrete technical facts, APIs, constraints, examples, and unresolved tasks. If you do not have the previous chunks in context, say exactly: NO_CONTEXT.';

function usage(exitCode = 1): never {
  console.log(`
Usage:
  pnpm --dir packages/backend exec tsx scripts/test_deepseek_hydration.ts

Options:
  --context <path>             Context markdown file.
                               Default: ${DEFAULT_CONTEXT_PATH}
  --chunk-chars <n>            Characters per hydration chunk. Default: 90000.
  --chunk-tokens <n>           Approximate tokens per chunk; converted to chars as n*4.
  --max-chunks <n>             Only send first n chunks.
  --cancel-mode <mode>         first-line | message-id | content | none. Default: none.
  --model-type <type>          DeepSeek model_type. Default: expert.
  --summary-prompt <text>      Prompt used after hydration.
  --token <token>              DeepSeek bearer token. Default: DEEPSEEK_TOKEN env.
                               If missing, login with DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD env.
  --raw                        Print raw SSE data lines.
  --keep-session               Do not delete the test session.
  --no-stop                    Do not call stop_stream after client-side abort.
  --delay-before-cancel-ms <n> Wait after first cancel trigger before aborting. Default: 0.
  --delay-after-cancel-ms <n>  Wait after cancel before continuing. Default: 0.
  --delay-between-chunks-ms <n>
                               Wait between hydration chunks and before summary. Default: 0.

Examples:
  pnpm --dir packages/backend exec tsx scripts/test_deepseek_hydration.ts --chunk-chars 90000 --cancel-mode message-id
  pnpm --dir packages/backend exec tsx scripts/test_deepseek_hydration.ts --chunk-tokens 30000 --cancel-mode none --max-chunks 1 --raw
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: process.env.DEEPSEEK_TOKEN,
    contextPath: DEFAULT_CONTEXT_PATH,
    chunkChars: 90000,
    cancelMode: 'none',
    modelType: 'expert',
    raw: false,
    keepSession: false,
    stopOnCancel: true,
    delayBeforeCancelMs: 0,
    delayAfterCancelMs: 0,
    delayBetweenChunksMs: 0,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token') args.token = argv[++i];
    else if (arg === '--context') args.contextPath = path.resolve(argv[++i]);
    else if (arg === '--chunk-chars') args.chunkChars = Number(argv[++i]);
    else if (arg === '--chunk-tokens') args.chunkTokens = Number(argv[++i]);
    else if (arg === '--max-chunks') args.maxChunks = Number(argv[++i]);
    else if (arg === '--cancel-mode') args.cancelMode = parseCancelMode(argv[++i]);
    else if (arg === '--model-type') args.modelType = argv[++i];
    else if (arg === '--summary-prompt') args.summaryPrompt = argv[++i];
    else if (arg === '--raw') args.raw = true;
    else if (arg === '--keep-session') args.keepSession = true;
    else if (arg === '--no-stop') args.stopOnCancel = false;
    else if (arg === '--delay-before-cancel-ms') args.delayBeforeCancelMs = Number(argv[++i]);
    else if (arg === '--delay-after-cancel-ms') args.delayAfterCancelMs = Number(argv[++i]);
    else if (arg === '--delay-between-chunks-ms') args.delayBetweenChunksMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.chunkTokens !== undefined) {
    if (!Number.isFinite(args.chunkTokens) || args.chunkTokens <= 0) throw new Error('--chunk-tokens must be > 0.');
    args.chunkChars = Math.floor(args.chunkTokens * 4);
  }

  if (!Number.isFinite(args.chunkChars) || args.chunkChars <= 0) throw new Error('--chunk-chars must be > 0.');
  if (args.maxChunks !== undefined && (!Number.isFinite(args.maxChunks) || args.maxChunks <= 0)) {
    throw new Error('--max-chunks must be > 0.');
  }
  if (!Number.isFinite(args.delayAfterCancelMs) || args.delayAfterCancelMs < 0) {
    throw new Error('--delay-after-cancel-ms must be >= 0.');
  }
  if (!Number.isFinite(args.delayBeforeCancelMs) || args.delayBeforeCancelMs < 0) {
    throw new Error('--delay-before-cancel-ms must be >= 0.');
  }
  if (!Number.isFinite(args.delayBetweenChunksMs) || args.delayBetweenChunksMs < 0) {
    throw new Error('--delay-between-chunks-ms must be >= 0.');
  }

  return args;
}

function parseCancelMode(value: string): CancelMode {
  if (value === 'first-line' || value === 'message-id' || value === 'content' || value === 'none') return value;
  throw new Error(`Invalid --cancel-mode: ${value}`);
}

async function resolveToken(args: Args): Promise<string> {
  if (args.token) return args.token;

  const cached = await readCachedToken();
  if (cached) {
    console.log(`[HYDRATE] using cached token from ${TOKEN_CACHE_PATH}`);
    return cached;
  }

  const email = process.env.DEEPSEEK_EMAIL;
  const password = process.env.DEEPSEEK_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing credentials. Set DEEPSEEK_TOKEN, or set DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD.');
  }

  console.log(`[HYDRATE] logging in as ${email}`);
  const token = await client.login(email, password);
  await writeCachedToken(token);
  return token;
}

async function readCachedToken(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(TOKEN_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof parsed.token !== 'string') return undefined;
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return undefined;
    return parsed.token;
  } catch {
    return undefined;
  }
}

async function writeCachedToken(token: string): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
  await fs.writeFile(
    TOKEN_CACHE_PATH,
    JSON.stringify({ token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS }, null, 2),
    'utf8',
  );
  console.log(`[HYDRATE] cached token at ${TOKEN_CACHE_PATH}`);
}

function chunkText(text: string, chunkChars: number, maxChunks?: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkChars) {
    chunks.push(text.slice(start, start + chunkChars));
    if (maxChunks && chunks.length >= maxChunks) break;
  }
  return chunks;
}

function buildHydrationPrompt(chunk: string, index: number, total: number): string {
  return [
    HYDRATION_REMEMBER_PROMPT,
    '',
    `<context_chunk index="${index}" total="${total}">`,
    chunk,
    '</context_chunk>',
  ].join('\n');
}

async function runCompletion(
  token: string,
  payload: DeepSeekCompletionPayload,
  label: string,
  raw: boolean,
  cancelMode: CancelMode,
  stopOnCancel: boolean,
  delayBeforeCancelMs: number,
  delayAfterCancelMs: number,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const powResponse = await client.getPowForTarget(token, '/api/v0/chat/completion');
  let text = '';
  let reasoning = '';
  let lineCount = 0;
  let parsedCount = 0;
  let requestMessageId: number | undefined;
  let responseMessageId: number | undefined;
  let stopped = false;
  let currentFragmentType: 'text' | 'thinking' | null = null;

  console.log(
    `[${label}] send modelType=${payload.model_type} parent=${payload.parent_message_id ?? '<null>'} ` +
      `promptLen=${payload.prompt.length} cancelMode=${cancelMode}`,
  );

  try {
    for await (const line of client.streamCompletionLines(token, powResponse, payload, controller.signal, {
      webHeaders: true,
    })) {
      lineCount++;
      const rawLine = line.slice(5).trim();
      if (!rawLine) continue;
      if (raw) console.log(`[${label} RAW ${lineCount}] ${rawLine}`);

      if (cancelMode === 'first-line') {
        stopped = true;
        controller.abort();
        break;
      }

      if (rawLine.includes('FINISHED') && rawLine.includes('response/status')) break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof parsed.request_message_id === 'number') requestMessageId = parsed.request_message_id;
      if (typeof parsed.response_message_id === 'number') responseMessageId = parsed.response_message_id;

      const delta = extractText(parsed, currentFragmentType);
      currentFragmentType = delta.nextType;
      if (delta.content || delta.reasoning) {
        parsedCount++;
        text += delta.content;
        reasoning += delta.reasoning;
      }

      if (cancelMode === 'message-id' && responseMessageId !== undefined) {
        stopped = true;
        controller.abort();
        break;
      }
      if (cancelMode === 'content' && (delta.content || delta.reasoning)) {
        if (delayBeforeCancelMs > 0) {
          console.log(`[${label}] waiting ${delayBeforeCancelMs}ms before cancel`);
          await sleep(delayBeforeCancelMs);
        }
        stopped = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }

  if (stopped && stopOnCancel && responseMessageId !== undefined) {
    await client.stopStream(token, payload.chat_session_id, responseMessageId);
  }
  if (stopped && delayAfterCancelMs > 0) {
    console.log(`[${label}] waiting ${delayAfterCancelMs}ms after cancel`);
    await sleep(delayAfterCancelMs);
  }

  console.log(
    `[${label}] done lines=${lineCount} parsed=${parsedCount} contentChars=${text.trim().length} ` +
      `reasoningChars=${reasoning.trim().length} req=${requestMessageId ?? '<none>'} ` +
      `res=${responseMessageId ?? '<none>'} stopped=${stopped}`,
  );

  return { text, reasoning, lineCount, parsedCount, requestMessageId, responseMessageId, stopped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(
  chunk: Record<string, unknown>,
  currentFragmentType: 'text' | 'thinking' | null,
): { content: string; reasoning: string; nextType: 'text' | 'thinking' | null } {
  const pathValue = chunk.p as string | undefined;
  const op = chunk.o as string | undefined;

  if (pathValue === 'response/fragments' && op === 'APPEND' && Array.isArray(chunk.v)) {
    return extractFragments(chunk.v as Array<Record<string, unknown>>);
  }

  if (!pathValue && !op && chunk.v && typeof chunk.v === 'object') {
    const vObj = chunk.v as Record<string, unknown>;
    const response = vObj.response as Record<string, unknown> | undefined;
    if (response?.fragments && Array.isArray(response.fragments)) {
      return extractFragments(response.fragments as Array<Record<string, unknown>>);
    }
  }

  const value = textValue(chunk.v);
  if (!value) return { content: '', reasoning: '', nextType: currentFragmentType };
  if (pathValue?.includes('thinking')) return { content: '', reasoning: value, nextType: 'thinking' };
  if (pathValue?.includes('/content')) {
    if (currentFragmentType === 'thinking') return { content: '', reasoning: value, nextType: 'thinking' };
    return { content: value, reasoning: '', nextType: 'text' };
  }
  if (currentFragmentType === 'thinking') return { content: '', reasoning: value, nextType: 'thinking' };
  if (currentFragmentType === 'text') return { content: value, reasoning: '', nextType: 'text' };
  return { content: '', reasoning: '', nextType: currentFragmentType };
}

function extractFragments(fragments: Array<Record<string, unknown>>): {
  content: string;
  reasoning: string;
  nextType: 'text' | 'thinking' | null;
} {
  let content = '';
  let reasoning = '';
  let nextType: 'text' | 'thinking' | null = null;
  for (const fragment of fragments) {
    const text = textValue(fragment.content);
    if (!text) continue;
    const type = fragment.type;
    if (type === 'THINK' || type === 'THINKING') {
      reasoning += text;
      nextType = 'thinking';
    } else {
      content += text;
      nextType = 'text';
    }
  }
  return { content, reasoning, nextType };
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (obj.text as string) || (obj.content as string) || '';
  }
  return '';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await resolveToken(args);
  const context = await fs.readFile(args.contextPath, 'utf8');
  const chunks = chunkText(context, args.chunkChars, args.maxChunks);
  const sessionId = await client.createSession(token);
  let parentMessageId: number | null = null;

  console.log(
    `[HYDRATE] file=${args.contextPath} chars=${context.length} approxTokens=${Math.ceil(context.length / 4)} ` +
      `chunkChars=${args.chunkChars} chunks=${chunks.length} session=${sessionId}`,
  );

  try {
    for (let i = 0; i < chunks.length; i++) {
      const payload: DeepSeekCompletionPayload = {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: args.modelType,
        prompt: buildHydrationPrompt(chunks[i], i + 1, chunks.length),
        thinking_enabled: false,
        search_enabled: false,
        ref_file_ids: [],
      };
      const result = await runCompletion(
        token,
        payload,
        `HYDRATE ${i + 1}/${chunks.length}`,
        args.raw,
        args.cancelMode,
        args.stopOnCancel,
        args.delayBeforeCancelMs,
        args.delayAfterCancelMs,
      );
      if (result.responseMessageId === undefined) {
        throw new Error(`Hydration chunk ${i + 1} did not return response_message_id.`);
      }
      parentMessageId = result.responseMessageId;
      if (args.delayBetweenChunksMs > 0) {
        console.log(`[HYDRATE] waiting ${args.delayBetweenChunksMs}ms before next step`);
        await sleep(args.delayBetweenChunksMs);
      }
    }

    const summary = await runCompletion(
      token,
      {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: args.modelType,
        prompt: args.summaryPrompt,
        thinking_enabled: false,
        search_enabled: false,
        ref_file_ids: [],
      },
      'SUMMARY',
      args.raw,
      'none',
      args.stopOnCancel,
      args.delayBeforeCancelMs,
      args.delayAfterCancelMs,
    );

    console.log('\n=== SUMMARY RESULT ===');
    console.log(`contentChars=${summary.text.trim().length} reasoningChars=${summary.reasoning.trim().length}`);
    console.log(summary.text.trim() || '<empty>');
  } finally {
    if (args.keepSession) {
      console.log(`[HYDRATE] keeping session=${sessionId}`);
    } else {
      await client.deleteSession(token, sessionId);
      console.log(`[HYDRATE] deleted session=${sessionId}`);
    }
  }
}

main().catch((err) => {
  console.error(`[HYDRATE] failed: ${(err as Error).message}`);
  process.exit(1);
});
