import path from 'path';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import * as chatgpt from '../src/providers/chatgpt/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

type Args = {
  token: string;
  model: string;
  firstPrompt: string;
  secondPrompt: string;
  filePrompt: string;
  raw: boolean;
  skipFile: boolean;
  cleanup: boolean;
};

type TurnResult = {
  conversationId: string;
  parentMessageId: string;
  text: string;
  events: number;
  ms: number;
};

type Timing = {
  label: string;
  ms: number;
  details?: Record<string, unknown>;
};

function usage(exitCode = 1): never {
  console.log(`
Usage:
  pnpm --dir packages/backend exec tsx scripts/test_chatgpt_provider.ts

Options:
  --token <token>          Default: CHATGPT_TOKEN env from packages/backend/.env
  --model <model>          Default: gpt-5-5
  --first-prompt <text>    Default: hello
  --second-prompt <text>   Default: reply in one short sentence
  --file-prompt <text>     Default: read attached file and say its exact content
  --raw                    Print parsed stream events.
  --skip-file              Only test create conversation + follow-up message.
  --cleanup                Hide the created ChatGPT web conversation after the test.
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: process.env.CHATGPT_TOKEN || '',
    model: process.env.CHATGPT_MODEL || 'gpt-5-5',
    firstPrompt: 'hello',
    secondPrompt: 'reply in one short sentence',
    filePrompt: 'read attached file and say its exact content',
    raw: false,
    skipFile: false,
    cleanup: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token') args.token = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--first-prompt') args.firstPrompt = argv[++i];
    else if (arg === '--second-prompt') args.secondPrompt = argv[++i];
    else if (arg === '--file-prompt') args.filePrompt = argv[++i];
    else if (arg === '--raw') args.raw = true;
    else if (arg === '--skip-file') args.skipFile = true;
    else if (arg === '--cleanup') args.cleanup = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.token) throw new Error('Missing CHATGPT_TOKEN. Add it to packages/backend/.env or pass --token.');
  return args;
}

async function runTurn(args: {
  token: string;
  meta: chatgpt.ChatGptAccountMeta;
  model: string;
  prompt: string;
  conversationId?: string;
  parentMessageId?: string;
  attachments?: chatgpt.UploadedFile[];
  label: string;
  raw: boolean;
}): Promise<TurnResult> {
  const started = Date.now();
  let conversationId = args.conversationId || '';
  let parentMessageId = args.parentMessageId || '';
  let text = '';
  let events = 0;

  console.log(
    `[CHATGPT-TEST] ${args.label}: submit conv=${conversationId || '<new>'} parent=${parentMessageId || '<root>'}`,
  );

  for await (const event of chatgpt.streamConversation(args.token, args.meta, {
    model: args.model,
    messages: [chatgpt.makeUserMessage(args.prompt, args.attachments || [])],
    conversationId: conversationId || undefined,
    parentMessageId: parentMessageId || undefined,
    attachments: args.attachments || [],
  })) {
    events++;
    if (event.conversationId) conversationId = event.conversationId;
    if (event.assistantMessageId) parentMessageId = event.assistantMessageId;
    if (event.textDelta) text += event.textDelta;
    if (args.raw) {
      console.log(
        `[CHATGPT-TEST] ${args.label} event=${events} conv=${event.conversationId || ''} ` +
          `assistant=${event.assistantMessageId || ''} finish=${event.finishReason || ''} ` +
          `delta=${JSON.stringify(event.textDelta || '')}`,
      );
    }
  }

  if (!conversationId) throw new Error(`${args.label}: stream did not return conversation_id`);
  if (!parentMessageId) throw new Error(`${args.label}: stream did not return assistant message id`);
  if (!text.trim()) throw new Error(`${args.label}: stream returned empty assistant content`);

  console.log(
    `[CHATGPT-TEST] ${args.label}: done ms=${Date.now() - started} events=${events} conv=${conversationId} parent=${parentMessageId} chars=${text.length}`,
  );
  console.log(`[CHATGPT-TEST] ${args.label} text: ${text.trim()}`);
  return { conversationId, parentMessageId, text, events, ms: Date.now() - started };
}

async function main(): Promise<void> {
  const totalStarted = Date.now();
  const timings: Timing[] = [];
  const recordTiming = (label: string, ms: number, details?: Record<string, unknown>): void => {
    timings.push({ label, ms, details });
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.log(`[CHATGPT-TEST] timing ${label}: ${ms}ms${suffix}`);
  };
  const args = parseArgs(process.argv.slice(2));
  const meta = chatgpt.buildAccountMeta({});
  meta.trace = recordTiming;

  const first = await runTurn({
    token: args.token,
    meta,
    model: args.model,
    prompt: args.firstPrompt,
    label: 'create-conversation',
    raw: args.raw,
  });

  const second = await runTurn({
    token: args.token,
    meta,
    model: args.model,
    prompt: args.secondPrompt,
    conversationId: first.conversationId,
    parentMessageId: first.parentMessageId,
    label: 'send-message',
    raw: args.raw,
  });

  let fileTurn: TurnResult | undefined;
  if (!args.skipFile) {
    const fileContent = `MARKER_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const fileName = `chatgpt-provider-test-${Date.now()}.txt`;
    console.log(`[CHATGPT-TEST] upload-file: bytes=${Buffer.byteLength(fileContent)} name=${fileName}`);
    const uploadStarted = Date.now();
    const uploaded = await chatgpt.uploadFile(args.token, meta, fileName, Buffer.from(fileContent), 'text/plain');
    recordTiming('script.upload_file', Date.now() - uploadStarted, {
      fileId: uploaded.fileId,
      bytes: uploaded.size,
    });
    console.log(`[CHATGPT-TEST] upload-file: fileId=${uploaded.fileId}`);
    try {
      const downloadStarted = Date.now();
      const downloaded = await chatgpt.downloadFileText(args.token, meta, uploaded.fileId);
      recordTiming('script.download_file_debug', Date.now() - downloadStarted, { fileId: uploaded.fileId });
      console.log(`[CHATGPT-TEST] upload-file: downloaded=${JSON.stringify(downloaded || '')}`);
      if (downloaded !== fileContent) {
        throw new Error(
          `downloaded content mismatch. expected=${JSON.stringify(fileContent)} actual=${JSON.stringify(downloaded)}`,
        );
      }
    } catch (err) {
      console.warn(`[CHATGPT-TEST] upload-file: direct download skipped: ${(err as Error).message}`);
    }

    fileTurn = await runTurn({
      token: args.token,
      meta,
      model: args.model,
      prompt: `${args.filePrompt}. Return only the exact MARKER_ line from the attached file. Do not shorten it.`,
      conversationId: second.conversationId,
      parentMessageId: second.parentMessageId,
      attachments: [uploaded],
      label: 'send-message-with-file',
      raw: args.raw,
    });
    if (!fileTurn.text.includes(fileContent)) {
      throw new Error(
        `send-message-with-file: response did not include uploaded file marker. marker=${fileContent} response=${fileTurn.text.slice(
          0,
          300,
        )}`,
      );
    }
  }

  console.log('\n=== CHATGPT PROVIDER TEST SUMMARY ===');
  console.log(`model=${args.model}`);
  console.log(`conversationId=${second.conversationId}`);
  console.log(`latestParentMessageId=${fileTurn?.parentMessageId || second.parentMessageId}`);
  console.log(`createEvents=${first.events} sendEvents=${second.events} fileEvents=${fileTurn?.events ?? 0}`);
  console.log(
    `createMs=${first.ms} sendMs=${second.ms} fileMs=${fileTurn?.ms ?? 0} totalMs=${Date.now() - totalStarted}`,
  );
  if (args.cleanup) {
    const cleanupStarted = Date.now();
    await chatgpt.deleteConversation(args.token, meta, second.conversationId);
    recordTiming('script.cleanup_conversation', Date.now() - cleanupStarted, {
      conversationId: second.conversationId,
    });
  }
  console.log('\n=== CHATGPT PROVIDER TIMINGS ===');
  for (const timing of timings) {
    const suffix = timing.details ? ` ${JSON.stringify(timing.details)}` : '';
    console.log(`${timing.label}: ${timing.ms}ms${suffix}`);
  }
}

main().catch((err) => {
  console.error(`[CHATGPT-TEST] failed: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
