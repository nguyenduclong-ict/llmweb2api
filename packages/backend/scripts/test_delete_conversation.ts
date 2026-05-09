import path from 'path';
import dotenv from 'dotenv';
import * as client from '../src/providers/deepseek/client';
import { DEEPSEEK_HOST, DEEPSEEK_URLS } from '../src/providers/deepseek/types';

dotenv.config({ path: path.resolve(__dirname, '../../..', '.env') });

type Args = {
  token?: string;
  sessionId?: string;
  confirmDeleteExisting: boolean;
  raw: boolean;
};

function usage(exitCode = 1): never {
  console.log(`
Usage:
  pnpm --filter @llmweb2api/backend test:delete-conversation
  pnpm --filter @llmweb2api/backend test:delete-conversation --session-id <deepseek-chat-session-id> --confirm-delete-existing

Options:
  --token <token>              DeepSeek bearer token. Default: DEEPSEEK_TOKEN env.
                              If missing, login with DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD env.
  --session-id <id>            Existing DeepSeek chat_session_id to delete.
                              If omitted, the script creates a fresh test session and deletes it.
  --confirm-delete-existing    Required when --session-id is provided.
  --raw                        Print raw JSON responses.
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: process.env.DEEPSEEK_TOKEN,
    confirmDeleteExisting: false,
    raw: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token') args.token = argv[++i];
    else if (arg === '--session-id') args.sessionId = argv[++i];
    else if (arg === '--confirm-delete-existing') args.confirmDeleteExisting = true;
    else if (arg === '--raw') args.raw = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.sessionId && !args.confirmDeleteExisting) {
    throw new Error('Refusing to delete an existing session without --confirm-delete-existing.');
  }

  return args;
}

async function resolveToken(args: Args): Promise<string> {
  if (args.token) return args.token;

  const email = process.env.DEEPSEEK_EMAIL;
  const password = process.env.DEEPSEEK_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing credentials. Set DEEPSEEK_TOKEN, or set DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD.');
  }

  console.log(`[DELETE-TEST] logging in as ${email}`);
  return client.login(email, password);
}

function webHeaders(token: string): Record<string, string> {
  return {
    Host: DEEPSEEK_HOST,
    Accept: '*/*',
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    Referer: 'https://chat.deepseek.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'x-app-version': '2.0.0',
    'x-client-locale': 'vi',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '25200',
    'x-client-version': '2.0.0',
  };
}

async function createWebSession(token: string): Promise<{ sessionId: string; raw: unknown }> {
  const response = await fetch(DEEPSEEK_URLS.createSession, {
    method: 'POST',
    headers: webHeaders(token),
    body: JSON.stringify({}),
  });
  const data = (await response.json()) as any;
  if (!response.ok || data.code !== 0 || data.data?.biz_code !== 0) {
    throw new Error(`Create session failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 500)}`);
  }

  const bizData = data.data?.biz_data;
  const sessionId = bizData?.chat_session?.id || bizData?.id;
  if (!sessionId) throw new Error(`Create session failed: no session id in ${JSON.stringify(data).slice(0, 500)}`);

  return { sessionId, raw: data };
}

async function deleteWebSession(token: string, sessionId: string): Promise<{ status: number; raw: unknown }> {
  const response = await fetch(DEEPSEEK_URLS.deleteSession, {
    method: 'POST',
    headers: webHeaders(token),
    body: JSON.stringify({ chat_session_id: sessionId }),
  });

  let data: unknown;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: response.status, raw: data };
}

function assertDeleteSucceeded(status: number, raw: unknown): void {
  if (status !== 200) throw new Error(`Delete failed: HTTP ${status} ${JSON.stringify(raw).slice(0, 500)}`);
  const data = raw as any;
  if (data?.code !== 0 || data?.data?.biz_code !== 0) {
    throw new Error(`Delete failed: ${JSON.stringify(raw).slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await resolveToken(args);

  let sessionId = args.sessionId;
  const createdSession = !sessionId;
  if (!sessionId) {
    const created = await createWebSession(token);
    sessionId = created.sessionId;
    console.log(`[DELETE-TEST] created test sessionId=${sessionId}`);
    if (args.raw) console.log(`[DELETE-TEST] create raw=${JSON.stringify(created.raw)}`);
  } else {
    console.log(`[DELETE-TEST] deleting existing sessionId=${sessionId}`);
  }

  const deleted = await deleteWebSession(token, sessionId);
  if (args.raw) console.log(`[DELETE-TEST] delete raw=${JSON.stringify(deleted.raw)}`);
  assertDeleteSucceeded(deleted.status, deleted.raw);
  console.log(`[DELETE-TEST] deleted sessionId=${sessionId} http=${deleted.status} createdByScript=${createdSession}`);
}

main().catch((err) => {
  console.error(`[DELETE-TEST] failed: ${(err as Error).message}`);
  process.exit(1);
});
