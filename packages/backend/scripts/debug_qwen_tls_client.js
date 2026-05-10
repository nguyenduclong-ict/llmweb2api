/* eslint-disable no-console */
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { ClientIdentifier, Session, destroyTLS, initTLS } = require('node-tls-client');

const repoRoot = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const QWEN_BASE_URL = 'https://chat.qwen.ai';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const token = process.env.QWEN_TOKEN;
const browserCookie = process.env.QWEN_COOKIE || '';
const browserBxUa = process.env.QWEN_BX_UA || '';
const browserCompletionBxUa = process.env.QWEN_COMPLETION_BX_UA || browserBxUa;
const browserBxUmidToken = process.env.QWEN_BX_UMIDTOKEN || '';
const authMode = process.env.QWEN_TLS_AUTH_MODE || 'bearer';
const model = process.argv[2] || 'qwen3.6-plus';
const prompt = process.argv.slice(3).join(' ') || 'Reply with exactly: hello from node tls client';
const prompts = prompt
  .split(/\s*\|\|\s*/)
  .map((item) => item.trim())
  .filter(Boolean);
const maxLines = Number(process.env.QWEN_DEBUG_MAX_LINES || 80);

if (!token) {
  console.error('Missing QWEN_TOKEN in .env');
  process.exit(1);
}

if (authMode === 'cookie' && (!browserCookie || !browserBxUa || !browserBxUmidToken)) {
  console.error('Missing one of QWEN_COOKIE, QWEN_BX_UA, QWEN_BX_UMIDTOKEN in .env');
  process.exit(1);
}

function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function formatBrowserTimezone(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const minutes = String(absMinutes % 60).padStart(2, '0');
  return `${date.toDateString()} ${date.toTimeString().split(' ')[0]} GMT${sign}${hours}${minutes}`;
}

function baseHeaders({ bxUa, referer, cookie, accept = 'application/json, text/plain, */*' }) {
  if (authMode !== 'cookie') {
    return {
      authorization: `Bearer ${token}`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: `${QWEN_BASE_URL}/`,
      origin: QWEN_BASE_URL,
      connection: 'keep-alive',
      'content-type': 'application/json',
    };
  }

  return {
    accept,
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'user-agent': WEB_USER_AGENT,
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    source: 'web',
    'bx-ua': bxUa,
    'bx-umidtoken': browserBxUmidToken,
    'bx-v': '2.5.36',
    cookie,
    referer,
    timezone: formatBrowserTimezone(),
    'x-accel-buffering': 'no',
    'x-request-id': uuidv4(),
  };
}

const headerOrder = [
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'source',
  'bx-ua',
  'bx-umidtoken',
  'bx-v',
  'cookie',
  'referer',
  'timezone',
  'x-accel-buffering',
  'x-request-id',
];

function parseCookieString(cookieString) {
  return Object.fromEntries(
    cookieString
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
      }),
  );
}

function mergeCookies(baseCookie, responseCookies) {
  const cookies = parseCookieString(baseCookie);
  for (const [name, value] of Object.entries(responseCookies || {})) {
    cookies[name] = value;
  }
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCompletionPayload(chatId, content, parentId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();
  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: parentId,
    messages: [
      {
        fid: userMessageId,
        parentId,
        childrenIds: [assistantMessageId],
        role: 'user',
        content,
        user_action: 'chat',
        files: [],
        timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: false,
          function_calling: false,
          enable_tools: false,
          enable_function_call: false,
          tool_choice: 'none',
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: parentId,
      },
    ],
    timestamp,
  };
}

async function createChat(session) {
  const body = {
    title: 'TLS Client Debug',
    models: [model],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Math.floor(Date.now() / 1000),
  };
  const response = await session.post(`${QWEN_BASE_URL}/api/v2/chats/new`, {
    headers: baseHeaders({
      bxUa: browserBxUa,
      referer: `${QWEN_BASE_URL}/c/new-chat`,
      cookie: browserCookie,
    }),
    headerOrder,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = safeJson(text);
  console.log('[createChat]', {
    status: response.status,
    ok: response.ok,
    contentType: response.headers['content-type'],
    cookies: Object.keys(response.cookies || {}),
    body: redact(data || text.slice(0, 500)),
  });
  if (!response.ok || !data?.success || !data?.data?.id) {
    throw new Error(`createChat failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return {
    chatId: data.data.id,
    cookie: mergeCookies(browserCookie, response.cookies),
  };
}

async function streamCompletion(session, chatId, cookie, content, parentId) {
  const response = await session.post(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, {
    headers: baseHeaders({
      bxUa: browserCompletionBxUa,
      referer: `${QWEN_BASE_URL}/c/${chatId}`,
      cookie,
      accept: authMode === 'cookie' ? 'application/json' : 'text/event-stream',
    }),
    headerOrder,
    body: JSON.stringify(buildCompletionPayload(chatId, content, parentId)),
  });
  const text = await response.text();
  console.log('[completion]', {
    status: response.status,
    ok: response.ok,
    contentType: response.headers['content-type'],
    usedProtocol: response.usedProtocol,
    bodyLength: text.length,
  });

  let parsedCount = 0;
  let responseCreated;
  let answer = '';
  text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, maxLines)
    .forEach((line, index) => {
      const data = parseLine(line);
      const parsed = data ? safeJson(data) : undefined;
      if (parsed) parsedCount++;
      responseCreated = parsed?.['response.created'] || responseCreated;
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.phase === 'answer' && typeof delta.content === 'string') {
        answer += delta.content;
      }
      console.log(`[line ${index + 1}]`, {
        raw: line.slice(0, 500),
        parsed: summarizeParsed(parsed),
      });
    });
  console.log('[summary]', {
    parsedCount,
    totalLines: text.split(/\r?\n/).filter((line) => line.trim()).length,
    responseId: responseCreated?.response_id,
    answer,
  });
  return responseCreated;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('data:')) return trimmed.slice(5).trim();
  if (trimmed.startsWith('{')) return trimmed;
  return '';
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summarizeParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  return redact({
    keys: Object.keys(parsed),
    type: parsed.type,
    event: parsed.event,
    code: parsed.code,
    msg: parsed.msg,
    responseCreated: parsed['response.created'] || parsed.response?.created,
    responseStatus: parsed.response?.status,
    delta: parsed.delta,
    choicesDelta: parsed.choices?.[0]?.delta,
    text: parsed.text,
    output: parsed.response?.output,
  });
}

function redact(value) {
  const text = JSON.stringify(value);
  return JSON.parse(text.replaceAll(token, '<QWEN_TOKEN>'));
}

async function main() {
  console.log('[debug]', {
    model,
    promptLength: prompt.length,
    turns: prompts.length,
    tokenPresent: Boolean(token),
    browserCookiePresent: Boolean(browserCookie),
    browserBaxiaPresent: Boolean(browserBxUa && browserBxUmidToken),
    authMode,
  });

  await initTLS();
  const session = new Session({
    clientIdentifier: ClientIdentifier.chrome_124,
    timeout: 120000,
    insecureSkipVerify: false,
    randomTlsExtensionOrder: true,
  });

  try {
    const chat = await createChat(session);
    console.log('[chat]', { chatId: chat.chatId, hasMergedCookie: Boolean(chat.cookie) });
    let parentId = null;
    for (const [index, content] of prompts.entries()) {
      console.log('[turn]', { index: index + 1, content });
      const responseCreated = await streamCompletion(session, chat.chatId, chat.cookie, content, parentId);
      parentId = responseCreated?.response_id || parentId;
    }
  } finally {
    await session.close();
    await destroyTLS();
  }
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
