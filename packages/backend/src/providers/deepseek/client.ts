import type { DeepSeekPowChallenge, DeepSeekCompletionPayload, DeepSeekUploadResult } from './types';
import { DEEPSEEK_URLS, BASE_HEADERS, MAX_FILE_SIZE } from './types';
import axios from 'axios';
import {
  initPowWasm,
  solvePow as solvePowWasm,
  buildPowHeader as buildPowHeaderWasm,
  isPowWasmAvailable,
} from './pow_native';

function authHeaders(token: string): Record<string, string> {
  return { ...BASE_HEADERS, authorization: `Bearer ${token}` };
}

export async function login(email: string, password: string): Promise<string> {
  const body = { email, password, device_id: 'deepseek_to_api', os: 'android' };

  const resp = await fetch(DEEPSEEK_URLS.login, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as any;
  if (data.code !== 0) throw new Error(`Login failed: ${data.msg}`);
  if (data.data?.biz_code !== 0) throw new Error(`Login failed: ${data.data?.biz_msg}`);

  const token = data.data?.biz_data?.user?.token;
  if (!token) throw new Error('Login failed: no token');

  return token;
}

export async function createSession(token: string): Promise<string> {
  const resp = await fetch(DEEPSEEK_URLS.createSession, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ agent: 'chat' }),
  });

  const data = (await resp.json()) as any;
  if (data.code !== 0 || data.data?.biz_code !== 0) {
    throw new Error('Create session failed');
  }

  const bizData = data.data?.biz_data;
  const sessionId = bizData?.chat_session?.id || bizData?.id;
  if (!sessionId) throw new Error('Create session failed: no session ID');

  return sessionId;
}

export async function getPow(token: string): Promise<{ challenge: DeepSeekPowChallenge; powResponse: string }> {
  const resp = await fetch(DEEPSEEK_URLS.createPow, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ target_path: DEEPSEEK_URLS.completionTarget }),
  });

  const data = (await resp.json()) as any;
  if (data.code !== 0 || data.data?.biz_code !== 0) throw new Error('Get PoW failed');

  const challenge: DeepSeekPowChallenge = data.data.biz_data.challenge;
  if (challenge.algorithm !== 'DeepSeekHashV1') throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);

  const start = Date.now();
  const answer = await solvePowFast(challenge);
  console.log(`[POW] Solved in ${Date.now() - start}ms, difficulty=${challenge.difficulty}, answer=${answer}`);

  const powResponse = buildPowResponse(challenge, answer);

  return { challenge, powResponse };
}

let powWasmReady = false;
let powWasmInit: Promise<void> | null = null;

async function ensurePowWasm(): Promise<boolean> {
  if (powWasmReady) return true;
  if (!isPowWasmAvailable()) {
    console.log('[POW] WASM files not found, using JS fallback');
    return false;
  }
  if (!powWasmInit) powWasmInit = initPowWasm();
  try {
    await powWasmInit;
    powWasmReady = true;
    console.log('[POW] WASM initialized successfully');
    return true;
  } catch (err) {
    console.log('[POW] WASM init failed, using JS fallback:', (err as Error).message);
    return false;
  }
}

async function solvePowFast(challenge: DeepSeekPowChallenge): Promise<number> {
  if (await ensurePowWasm()) {
    return solvePowWasm(challenge.challenge, challenge.salt, challenge.expire_at, challenge.difficulty);
  }
  return computePoW(challenge);
}

function buildPowResponse(challenge: DeepSeekPowChallenge, answer: number): string {
  if (powWasmReady) {
    try {
      return buildPowHeaderWasm(
        challenge.algorithm,
        challenge.challenge,
        challenge.salt,
        answer,
        challenge.signature,
        challenge.target_path,
      );
    } catch {
      // fall through to JS
    }
  }
  const powPayload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(powPayload)).toString('base64');
}

function computePoW(challenge: DeepSeekPowChallenge): number {
  const { challenge: challengeHex, salt, expire_at, difficulty } = challenge;

  if (challengeHex.length !== 64) throw new Error('PoW: challenge must be 64 hex chars');

  const targetBytes = Buffer.from(challengeHex, 'hex');
  const t0 = targetBytes.readBigUInt64LE(0);
  const t1 = targetBytes.readBigUInt64LE(8);
  const t2 = targetBytes.readBigUInt64LE(16);
  const t3 = targetBytes.readBigUInt64LE(24);

  const prefix = `${salt}_${expire_at}_`;
  const prefixBytes = Buffer.from(prefix, 'utf-8');

  const RATE = 136;
  const baseState = new Array<bigint>(25).fill(0n);

  let off = 0;
  while (off + RATE <= prefixBytes.length) {
    for (let i = 0; i < RATE / 8; i++) {
      baseState[i] ^= prefixBytes.readBigUInt64LE(off + i * 8);
    }
    keccakF23BI(baseState);
    off += RATE;
  }

  const tailLen = prefixBytes.length - off;
  const tail = Buffer.alloc(RATE);
  prefixBytes.copy(tail, 0, off, prefixBytes.length);

  for (let n = 0; n <= difficulty; n++) {
    const numStr = String(n);
    const numBytes = Buffer.from(numStr, 'utf-8');
    const totalTail = tailLen + numBytes.length;

    const s = [...baseState];

    if (totalTail < RATE) {
      const buf = Buffer.alloc(RATE);
      tail.copy(buf, 0, 0, tailLen);
      numBytes.copy(buf, tailLen);
      buf[totalTail] = 0x06;
      buf[RATE - 1] |= 0x80;
      for (let i = 0; i < RATE / 8; i++) {
        s[i] ^= buf.readBigUInt64LE(i * 8);
      }
      keccakF23BI(s);
    } else {
      const buf = Buffer.alloc(RATE);
      tail.copy(buf, 0, 0, tailLen);
      numBytes.copy(buf, tailLen);
      for (let i = 0; i < RATE / 8; i++) {
        s[i] ^= buf.readBigUInt64LE(i * 8);
      }
      keccakF23BI(s);

      const buf2 = Buffer.alloc(RATE);
      const rem = totalTail - RATE;
      numBytes.copy(buf2, 0, RATE - tailLen);
      buf2[rem] = 0x06;
      buf2[RATE - 1] |= 0x80;
      for (let i = 0; i < RATE / 8; i++) {
        s[i] ^= buf2.readBigUInt64LE(i * 8);
      }
      keccakF23BI(s);
    }

    if (s[0] === t0 && s[1] === t1 && s[2] === t2 && s[3] === t3) return n;
  }

  throw new Error('PoW computation failed');
}

const RC: bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

function rotlBI(v: bigint, k: number): bigint {
  return ((v << BigInt(k)) | (v >> BigInt(64 - k))) & 0xffffffffffffffffn;
}

function keccakF23BI(s: bigint[]): void {
  let a0 = s[0],
    a1 = s[1],
    a2 = s[2],
    a3 = s[3],
    a4 = s[4];
  let a5 = s[5],
    a6 = s[6],
    a7 = s[7],
    a8 = s[8],
    a9 = s[9];
  let a10 = s[10],
    a11 = s[11],
    a12 = s[12],
    a13 = s[13],
    a14 = s[14];
  let a15 = s[15],
    a16 = s[16],
    a17 = s[17],
    a18 = s[18],
    a19 = s[19];
  let a20 = s[20],
    a21 = s[21],
    a22 = s[22],
    a23 = s[23],
    a24 = s[24];

  for (let r = 1; r < 24; r++) {
    const c0 = a0 ^ a5 ^ a10 ^ a15 ^ a20;
    const c1 = a1 ^ a6 ^ a11 ^ a16 ^ a21;
    const c2 = a2 ^ a7 ^ a12 ^ a17 ^ a22;
    const c3 = a3 ^ a8 ^ a13 ^ a18 ^ a23;
    const c4 = a4 ^ a9 ^ a14 ^ a19 ^ a24;

    const d0 = c4 ^ rotlBI(c1, 1);
    const d1 = c0 ^ rotlBI(c2, 1);
    const d2 = c1 ^ rotlBI(c3, 1);
    const d3 = c2 ^ rotlBI(c4, 1);
    const d4 = c3 ^ rotlBI(c0, 1);

    a0 ^= d0;
    a5 ^= d0;
    a10 ^= d0;
    a15 ^= d0;
    a20 ^= d0;
    a1 ^= d1;
    a6 ^= d1;
    a11 ^= d1;
    a16 ^= d1;
    a21 ^= d1;
    a2 ^= d2;
    a7 ^= d2;
    a12 ^= d2;
    a17 ^= d2;
    a22 ^= d2;
    a3 ^= d3;
    a8 ^= d3;
    a13 ^= d3;
    a18 ^= d3;
    a23 ^= d3;
    a4 ^= d4;
    a9 ^= d4;
    a14 ^= d4;
    a19 ^= d4;
    a24 ^= d4;

    const b0 = a0;
    const b10 = rotlBI(a1, 1);
    const b20 = rotlBI(a2, 62);
    const b5 = rotlBI(a3, 28);
    const b15 = rotlBI(a4, 27);
    const b16 = rotlBI(a5, 36);
    const b1 = rotlBI(a6, 44);
    const b11 = rotlBI(a7, 6);
    const b21 = rotlBI(a8, 55);
    const b6 = rotlBI(a9, 20);
    const b7 = rotlBI(a10, 3);
    const b17 = rotlBI(a11, 10);
    const b2 = rotlBI(a12, 43);
    const b12 = rotlBI(a13, 25);
    const b22 = rotlBI(a14, 39);
    const b23 = rotlBI(a15, 41);
    const b8 = rotlBI(a16, 45);
    const b18 = rotlBI(a17, 15);
    const b3 = rotlBI(a18, 21);
    const b13 = rotlBI(a19, 8);
    const b14 = rotlBI(a20, 18);
    const b24 = rotlBI(a21, 2);
    const b9 = rotlBI(a22, 61);
    const b19 = rotlBI(a23, 56);
    const b4 = rotlBI(a24, 14);

    a0 = b0 ^ (~b1 & b2);
    a1 = b1 ^ (~b2 & b3);
    a2 = b2 ^ (~b3 & b4);
    a3 = b3 ^ (~b4 & b0);
    a4 = b4 ^ (~b0 & b1);
    a5 = b5 ^ (~b6 & b7);
    a6 = b6 ^ (~b7 & b8);
    a7 = b7 ^ (~b8 & b9);
    a8 = b8 ^ (~b9 & b5);
    a9 = b9 ^ (~b5 & b6);
    a10 = b10 ^ (~b11 & b12);
    a11 = b11 ^ (~b12 & b13);
    a12 = b12 ^ (~b13 & b14);
    a13 = b13 ^ (~b14 & b10);
    a14 = b14 ^ (~b10 & b11);
    a15 = b15 ^ (~b16 & b17);
    a16 = b16 ^ (~b17 & b18);
    a17 = b17 ^ (~b18 & b19);
    a18 = b18 ^ (~b19 & b15);
    a19 = b19 ^ (~b15 & b16);
    a20 = b20 ^ (~b21 & b22);
    a21 = b21 ^ (~b22 & b23);
    a22 = b22 ^ (~b23 & b24);
    a23 = b23 ^ (~b24 & b20);
    a24 = b24 ^ (~b20 & b21);

    a0 ^= RC[r];
  }

  s[0] = a0;
  s[1] = a1;
  s[2] = a2;
  s[3] = a3;
  s[4] = a4;
  s[5] = a5;
  s[6] = a6;
  s[7] = a7;
  s[8] = a8;
  s[9] = a9;
  s[10] = a10;
  s[11] = a11;
  s[12] = a12;
  s[13] = a13;
  s[14] = a14;
  s[15] = a15;
  s[16] = a16;
  s[17] = a17;
  s[18] = a18;
  s[19] = a19;
  s[20] = a20;
  s[21] = a21;
  s[22] = a22;
  s[23] = a23;
  s[24] = a24;
}

export async function chatCompletion(
  token: string,
  powResponse: string,
  payload: DeepSeekCompletionPayload,
): Promise<Response> {
  const headers = {
    ...authHeaders(token),
    'x-ds-pow-response': powResponse,
  };

  return fetch(DEEPSEEK_URLS.completion, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

export async function* streamCompletionLines(
  token: string,
  powResponse: string,
  payload: DeepSeekCompletionPayload,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const headers = {
    ...authHeaders(token),
    'x-ds-pow-response': powResponse,
  };

  const response = await axios.post(DEEPSEEK_URLS.completion, JSON.stringify(payload), {
    headers,
    responseType: 'stream',
    validateStatus: () => true,
    signal,
  });

  if (signal?.aborted) return;

  if (response.status !== 200) {
    console.error(`[STREAM] HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`);
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  }

  const stream = response.data as NodeJS.ReadableStream;
  let buffer = '';

  for await (const chunk of stream) {
    if (signal?.aborted) {
      (stream as any).destroy();
      return;
    }
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      yield line;
    }
  }

  if (!signal?.aborted && buffer.startsWith('data:')) {
    yield buffer;
  }
}

export interface EditMessagePayload {
  chat_session_id: string;
  message_id: number;
  prompt: string;
  search_enabled?: boolean;
  thinking_enabled?: boolean;
}

export async function* streamEditMessageLines(
  token: string,
  powResponse: string,
  payload: EditMessagePayload,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const headers = {
    ...authHeaders(token),
    'x-ds-pow-response': powResponse,
  };

  const response = await axios.post(DEEPSEEK_URLS.editMessage, JSON.stringify(payload), {
    headers,
    responseType: 'stream',
    validateStatus: () => true,
    signal,
  });

  if (signal?.aborted) return;

  if (response.status !== 200) {
    console.error(`[EDIT] HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`);
    throw new Error(`DeepSeek edit_message returned HTTP ${response.status}`);
  }

  const stream = response.data as NodeJS.ReadableStream;
  let buffer = '';

  for await (const chunk of stream) {
    if (signal?.aborted) {
      (stream as any).destroy();
      return;
    }
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      yield line;
    }
  }

  if (!signal?.aborted && buffer.startsWith('data:')) {
    yield buffer;
  }
}

export async function stopStream(token: string, sessionId: string, messageId: string | number): Promise<void> {
  try {
    await fetch(DEEPSEEK_URLS.stopStream, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ chat_session_id: sessionId, message_id: Number(messageId) }),
    });
    console.log(`[STOP_STREAM] session=${sessionId.slice(0, 12)} message=${messageId}`);
  } catch (err) {
    console.error(`[STOP_STREAM] Failed: ${(err as Error).message}`);
  }
}

export async function deleteSession(token: string, sessionId: string): Promise<void> {
  await fetch(DEEPSEEK_URLS.deleteSession, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ chat_session_id: sessionId }),
  });
}

export async function getPowForTarget(token: string, targetPath: string): Promise<string> {
  const resp = await fetch(DEEPSEEK_URLS.createPow, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ target_path: targetPath }),
  });

  const data = (await resp.json()) as any;
  if (data.code !== 0 || data.data?.biz_code !== 0) throw new Error('Get PoW failed for upload');

  const challenge: DeepSeekPowChallenge = data.data.biz_data.challenge;
  const start = Date.now();
  const answer = await solvePowFast(challenge);
  console.log(`[POW] Solved in ${Date.now() - start}ms, difficulty=${challenge.difficulty}, answer=${answer}`);

  return buildPowResponse(challenge, answer);
}

export async function uploadFile(
  token: string,
  filename: string,
  content: string | Uint8Array,
  contentType: string = 'text/plain',
): Promise<DeepSeekUploadResult> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);

  if (data.length > MAX_FILE_SIZE) throw new Error(`File too large: ${data.length} bytes (max ${MAX_FILE_SIZE})`);

  const powResponse = await getPowForTarget(token, DEEPSEEK_URLS.uploadTarget);
  const boundary = `----FormBoundary${Date.now().toString(36)}`;

  const lines: string[] = [];
  lines.push(`--${boundary}`);
  lines.push(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
  lines.push(`Content-Type: ${contentType}`);
  lines.push('');
  const headBytes = Buffer.from(lines.join('\r\n') + '\r\n', 'utf-8');
  const tailBytes = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([headBytes, data, tailBytes]);

  const headers: Record<string, string> = {
    ...authHeaders(token),
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'x-ds-pow-response': powResponse,
    'x-file-size': String(data.length),
    'x-thinking-enabled': '1',
  };

  const resp = await fetch(DEEPSEEK_URLS.uploadFile, {
    method: 'POST',
    headers,
    body,
  });

  const respData = (await resp.json()) as any;
  if (respData.code !== 0 || respData.data?.biz_code !== 0) {
    const msg = respData.data?.biz_msg || respData.msg || 'Upload failed';
    throw new Error(`Upload failed: ${msg}`);
  }

  const bizData = respData.data?.biz_data;
  const result: DeepSeekUploadResult = {
    id: bizData?.id || bizData?.file_id || '',
    filename: bizData?.filename || filename,
    bytes: bizData?.bytes || data.length,
    status: bizData?.status || 'uploaded',
  };

  if (!result.id) throw new Error('Upload failed: no file ID');

  return result;
}

export async function pollFileReady(token: string, fileId: string): Promise<void> {
  const maxAttempts = 10;
  const interval = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval);
    const url = `${DEEPSEEK_URLS.fetchFiles}?file_ids=${encodeURIComponent(fileId)}`;
    const resp = await fetch(url, { headers: authHeaders(token) });

    if (resp.status === 200) {
      const data = (await resp.json()) as any;
      const files = data.data?.biz_data?.files || data.data?.files || [];
      if (files.length > 0) {
        const status = files[0].status || '';
        console.log(`[POLL] file=${fileId} attempt=${i + 1} status="${status}"`);
        if (
          [
            'processed',
            'ready',
            'done',
            'available',
            'success',
            'SUCCESS',
            'completed',
            'finished',
            'uploaded',
          ].includes(status)
        ) {
          return;
        }
      }
    }
  }
  console.log(`[POLL] file=${fileId} timeout after ${maxAttempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
