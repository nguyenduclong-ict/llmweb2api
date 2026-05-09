import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import * as client from '../src/providers/deepseek/client';
import type { DeepSeekCompletionPayload } from '../src/providers/deepseek/types';

dotenv.config({ path: path.resolve(__dirname, '../../..', '.env') });

type Args = {
  token?: string;
  image?: string;
  fileId?: string;
  prompt: string;
  raw: boolean;
  keepSession: boolean;
  direct: boolean;
  normalThenImage: boolean;
  sessionId?: string;
  parentMessageId?: number | null;
  modelType: string;
  normalModelType: string;
  firstPrompt: string;
};

type ParsedResult = {
  content: string;
  reasoningContent?: string;
  nextType: string | null;
};

type CompletionResult = {
  text: string;
  reasoning: string;
  requestMessageId?: number;
  responseMessageId?: number;
  lineCount: number;
  parsedCount: number;
};

const VISION_SYSTEM_PROMPT = [
  'Ban la model vision phu tro. Hay phan tich cac anh duoc dinh kem de ho tro model chinh.',
  '',
  'Yeu cau:',
  '- Tra loi bang tieng Viet neu nguoi dung dung tieng Viet.',
  '- Mo ta cac chi tiet quan trong trong anh.',
  '- OCR moi chu nhin thay duoc neu co.',
  '- Tra loi truc tiep yeu cau cuoi cua nguoi dung dua tren anh.',
  '- Khong goi cong cu.',
  '- Khong noi rang ban khong thay anh neu anh da duoc dinh kem.',
].join('\n');

function usage(exitCode = 1): never {
  console.log(`
Usage:
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --image <path|url|data-url>
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --file-id <deepseek-file-id>

Options:
  --token <token>       DeepSeek bearer token. Default: DEEPSEEK_TOKEN env.
                       If missing, login with DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD env.
  --prompt <text>       User prompt. Default: "day la gi?"
  --raw                 Print every raw SSE data line.
  --keep-session        Do not delete the temporary session.
  --direct              Send image directly to a conversation, no temporary vision side-session.
  --normal-then-image   Create/use a session, send one normal text message first, then send the image.
  --session-id <id>     Existing DeepSeek chat_session_id for --direct. If omitted, create a new session.
  --parent-message-id <id>
                       Parent message id for --direct. Default: null.
  --model-type <type>   DeepSeek model_type for completion. Default: vision.
  --normal-model-type <type>
                       DeepSeek model_type for the first message in --normal-then-image. Default: default.
  --first-prompt <text> First normal text prompt for --normal-then-image. Default: "hello".

Examples:
  $env:DEEPSEEK_EMAIL="..."
  $env:DEEPSEEK_PASSWORD="..."
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --image C:\\tmp\\image.png --raw
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --file-id file-b02f2344-b33d-4256-8565-635d2e1c3633 --prompt "day la gi?"
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --direct --session-id <chat_session_id> --parent-message-id 2 --image C:\\tmp\\image.png --raw
  pnpm --dir packages/backend exec tsx scripts/test_temporary_vision.ts --normal-then-image --image C:\\tmp\\image.png --first-prompt "hello" --prompt "day la gi?" --raw
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: process.env.DEEPSEEK_TOKEN,
    prompt: 'day la gi?',
    raw: false,
    keepSession: false,
    direct: false,
    normalThenImage: false,
    parentMessageId: null,
    modelType: 'vision',
    normalModelType: 'default',
    firstPrompt: 'hello',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token') args.token = argv[++i];
    else if (arg === '--image') args.image = argv[++i];
    else if (arg === '--file-id') args.fileId = argv[++i];
    else if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--raw') args.raw = true;
    else if (arg === '--keep-session') args.keepSession = true;
    else if (arg === '--direct') args.direct = true;
    else if (arg === '--normal-then-image') args.normalThenImage = true;
    else if (arg === '--session-id') args.sessionId = argv[++i];
    else if (arg === '--parent-message-id') args.parentMessageId = Number(argv[++i]);
    else if (arg === '--model-type') args.modelType = argv[++i];
    else if (arg === '--normal-model-type') args.normalModelType = argv[++i];
    else if (arg === '--first-prompt') args.firstPrompt = argv[++i];
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.image && !args.fileId) throw new Error('Pass either --image or --file-id.');
  if (args.image && args.fileId) throw new Error('Pass only one of --image or --file-id.');

  return args;
}

async function resolveToken(args: Args): Promise<string> {
  if (args.token) return args.token;

  const email = process.env.DEEPSEEK_EMAIL;
  const password = process.env.DEEPSEEK_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing credentials. Set DEEPSEEK_TOKEN, or set DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD.');
  }

  console.log(`[TEST] logging in as ${email}`);
  return client.login(email, password);
}

async function uploadImage(token: string, image: string): Promise<string> {
  if (image.startsWith('http://') || image.startsWith('https://')) {
    const response = await fetch(image);
    if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
    return uploadImageBytes(token, bytes, contentType, `image.${extensionForMime(contentType)}`);
  }

  if (image.startsWith('data:')) {
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL.');
    const contentType = match[1];
    const bytes = Buffer.from(match[2], 'base64');
    return uploadImageBytes(token, bytes, contentType, `image.${extensionForMime(contentType)}`);
  }

  const absolutePath = path.resolve(image);
  const bytes = await fs.readFile(absolutePath);
  const contentType = mimeForPath(absolutePath);
  const filename = path.basename(absolutePath);
  return uploadImageBytes(token, bytes, contentType, filename);
}

async function uploadImageBytes(token: string, bytes: Buffer, contentType: string, filename: string): Promise<string> {
  console.log(`[TEST] uploading ${filename} bytes=${bytes.length} contentType=${contentType}`);
  const result = await client.uploadImageFile(token, filename, bytes, contentType);
  console.log(`[TEST] uploaded fileId=${result.id} status=${result.status}`);
  await client.pollFileReady(token, result.id, { webHeaders: contentType.toLowerCase().startsWith('image/') });
  return result.id;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/bmp') return 'bmp';
  return 'png';
}

function block(role: string, content: string): string {
  return `<｜${role}｜>\n${content}\n<｜end▁of▁sentence｜>`;
}

function buildVisionPrompt(userPrompt: string): string {
  return [block('system', VISION_SYSTEM_PROMPT), block('user', `${userPrompt}\n\n[image]`)].join('\n\n');
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
  const pathValue = chunk.p as string | undefined;
  const op = chunk.o as string | undefined;

  if (pathValue === 'response/fragments' && op === 'APPEND' && Array.isArray(chunk.v)) {
    const { text, thinking, nextType } = parseFragments(chunk.v as Array<Record<string, unknown>>);
    if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
  }

  if (!pathValue && !op && chunk.v && typeof chunk.v === 'object') {
    const vObj = chunk.v as Record<string, unknown>;
    const response = vObj.response as Record<string, unknown> | undefined;
    if (response?.fragments && Array.isArray(response.fragments)) {
      const { text, thinking, nextType } = parseFragments(response.fragments as Array<Record<string, unknown>>);
      if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
    }
  }

  const text = extractTextValue(chunk.v);
  if (!text) return null;

  if (pathValue?.endsWith('/content')) {
    if (currentFragmentType === 'thinking') {
      return { content: '', reasoningContent: text, nextType: 'thinking' };
    }
    return { content: text, nextType: 'text' };
  }

  if (pathValue?.includes('thinking') || pathValue?.includes('reasoning')) {
    return { content: '', reasoningContent: text, nextType: 'thinking' };
  }

  if (!pathValue && currentFragmentType) {
    return {
      content: currentFragmentType === 'thinking' ? '' : text,
      reasoningContent: currentFragmentType === 'thinking' ? text : undefined,
      nextType: currentFragmentType,
    };
  }

  return null;
}

function extractTextValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (obj.text as string) || (obj.content as string) || '';
  }
  return '';
}

function describeChunk(chunk: Record<string, unknown>): string {
  const p = chunk.p ? ` p=${String(chunk.p)}` : '';
  const o = chunk.o ? ` o=${String(chunk.o)}` : '';
  const keys = Object.keys(chunk).join(',');
  const requestMessageId = chunk.request_message_id ? ` reqMsg=${String(chunk.request_message_id)}` : '';
  const responseMessageId = chunk.response_message_id ? ` resMsg=${String(chunk.response_message_id)}` : '';
  return `keys=${keys}${p}${o}${requestMessageId}${responseMessageId}`;
}

async function runCompletion(
  token: string,
  payload: DeepSeekCompletionPayload,
  raw: boolean,
  label: string,
  options: { webHeaders?: boolean } = {},
): Promise<CompletionResult> {
  const powResponse = await client.getPowForTarget(token, '/api/v0/chat/completion');
  let text = '';
  let reasoning = '';
  let currentFragmentType: string | null = null;
  let lineCount = 0;
  let parsedCount = 0;
  let requestMessageId: number | undefined;
  let responseMessageId: number | undefined;

  console.log(
    `[${label}] completion modelType=${payload.model_type} parentMessageId=${
      payload.parent_message_id ?? '<null>'
    } promptLen=${payload.prompt.length} refFiles=${payload.ref_file_ids?.length ?? 0}`,
  );

  for await (const line of client.streamCompletionLines(token, powResponse, payload, undefined, options)) {
    lineCount++;
    const rawLine = line.slice(5).trim();
    if (!rawLine) continue;
    if (raw) console.log(`[${label} RAW ${lineCount}] ${rawLine}`);
    if (rawLine.includes('FINISHED') && rawLine.includes('response/status')) {
      console.log(`[${label} EVENT ${lineCount}] finished status chunk`);
      break;
    }

    try {
      const chunk = JSON.parse(rawLine) as Record<string, unknown>;
      console.log(`[${label} EVENT ${lineCount}] ${describeChunk(chunk)}`);
      if (typeof chunk.request_message_id === 'number') requestMessageId = chunk.request_message_id;
      if (typeof chunk.response_message_id === 'number') responseMessageId = chunk.response_message_id;

      const result = parseContent(chunk, currentFragmentType);
      if (!result) continue;

      parsedCount++;
      currentFragmentType = result.nextType;
      text += result.content;
      if (result.reasoningContent) reasoning += result.reasoningContent;
      console.log(
        `[${label} PARSED ${parsedCount}] content+=${result.content.length} reasoning+=${
          result.reasoningContent?.length ?? 0
        } next=${result.nextType}`,
      );
    } catch (err) {
      console.log(`[${label} EVENT ${lineCount}] non-json ${String(err)}`);
    }
  }

  console.log(
    `[${label}] done lines=${lineCount} parsed=${parsedCount} contentChars=${text.trim().length} reasoningChars=${
      reasoning.trim().length
    } requestMessageId=${requestMessageId ?? '<none>'} responseMessageId=${responseMessageId ?? '<none>'}`,
  );

  return { text, reasoning, requestMessageId, responseMessageId, lineCount, parsedCount };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await resolveToken(args);
  const sessionId = args.sessionId ?? (await client.createSession(token));
  const createdSession = !args.sessionId;

  console.log(
    `[TEST] mode=${args.normalThenImage ? 'normal-then-image' : args.direct ? 'direct' : 'temporary-vision'}`,
  );
  console.log(`[TEST] sessionId=${sessionId}${createdSession ? ' (created)' : ' (existing)'}`);

  try {
    if (args.normalThenImage) {
      const firstPayload: DeepSeekCompletionPayload = {
        chat_session_id: sessionId,
        parent_message_id: args.parentMessageId ?? null,
        model_type: args.normalModelType,
        prompt: args.firstPrompt,
        thinking_enabled: false,
        search_enabled: false,
        ref_file_ids: [],
      };
      const first = await runCompletion(token, firstPayload, args.raw, 'STEP1-NORMAL', { webHeaders: true });
      const parentMessageId = first.responseMessageId;
      if (parentMessageId == null) {
        throw new Error('First normal completion did not return response_message_id; cannot continue image turn.');
      }

      const fileId = args.fileId ?? (await uploadImage(token, args.image as string));
      console.log(`[TEST] fileId=${fileId}`);

      const secondPayload: DeepSeekCompletionPayload = {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: args.modelType,
        prompt: args.prompt,
        thinking_enabled: false,
        search_enabled: false,
        ref_file_ids: [fileId],
      };
      const second = await runCompletion(token, secondPayload, args.raw, 'STEP2-IMAGE', { webHeaders: true });

      console.log('\n=== SUMMARY ===');
      console.log(
        `sessionId=${sessionId} firstResponseMessageId=${parentMessageId} secondResponseMessageId=${
          second.responseMessageId ?? '<none>'
        }`,
      );
      console.log('\n=== FIRST CONTENT ===');
      console.log(first.text.trim() || '<empty>');
      console.log('\n=== IMAGE CONTENT ===');
      console.log(second.text.trim() || '<empty>');
      if (second.reasoning.trim()) {
        console.log('\n=== IMAGE REASONING ===');
        console.log(second.reasoning.trim());
      }
      return;
    }

    const fileId = args.fileId ?? (await uploadImage(token, args.image as string));
    console.log(`[TEST] fileId=${fileId}`);

    const prompt = args.direct ? args.prompt : buildVisionPrompt(args.prompt);
    const payload: DeepSeekCompletionPayload = {
      chat_session_id: sessionId,
      parent_message_id: args.direct ? (args.parentMessageId ?? null) : null,
      model_type: args.modelType,
      prompt,
      thinking_enabled: false,
      search_enabled: false,
      ref_file_ids: [fileId],
    };
    const result = await runCompletion(token, payload, args.raw, 'TEST', { webHeaders: args.modelType === 'vision' });

    console.log('\n=== SUMMARY ===');
    console.log(
      `lines=${result.lineCount} parsed=${result.parsedCount} contentChars=${
        result.text.trim().length
      } reasoningChars=${result.reasoning.trim().length} requestMessageId=${
        result.requestMessageId ?? '<none>'
      } responseMessageId=${result.responseMessageId ?? '<none>'}`,
    );
    console.log('\n=== CONTENT ===');
    console.log(result.text.trim() || '<empty>');
    if (result.reasoning.trim()) {
      console.log('\n=== REASONING ===');
      console.log(result.reasoning.trim());
    }
  } finally {
    if (args.keepSession || !createdSession) {
      console.log(`[TEST] keeping sessionId=${sessionId}`);
    } else {
      await client.deleteSession(token, sessionId);
      console.log(`[TEST] deleted sessionId=${sessionId}`);
    }
  }
}

main().catch((err) => {
  console.error(`[TEST] failed: ${(err as Error).message}`);
  process.exit(1);
});
