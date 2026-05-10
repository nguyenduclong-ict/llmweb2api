/* eslint-disable no-console */
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const QWEN_BASE_URL = 'https://chat.qwen.ai';
const BAXIA_VERSION = '2.5.36';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const token = process.env.QWEN_TOKEN;
const browserCookie = process.env.QWEN_COOKIE || '';
const browserBxUa = process.env.QWEN_BX_UA || '';
const browserCompletionBxUa = process.env.QWEN_COMPLETION_BX_UA || '';
const browserBxUmidToken = process.env.QWEN_BX_UMIDTOKEN || '';
const mode = process.argv[2] === '--discover' ? 'discover' : process.argv[2] === '--assets' ? 'assets' : 'stream';
const model = mode === 'stream' ? process.argv[2] || 'qwen3.6-plus' : 'qwen3.6-plus';
const prompt = mode === 'stream' ? process.argv.slice(3).join(' ') || 'Reply with exactly: hello from qwen sse' : '';
const maxLines = Number(process.env.QWEN_DEBUG_MAX_LINES || 80);

if (!token) {
  console.error('Missing QWEN_TOKEN in .env');
  process.exit(1);
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let index = 0; index < length; index++) {
    result += chars[randomBytes[index] % chars.length];
  }
  return result;
}

function cryptoHash(data) {
  return crypto.createHash('md5').update(data).digest('base64').substring(0, 32);
}

function encodeBaxiaToken(data) {
  return `${BAXIA_VERSION.replace(/\./g, '')}!${Buffer.from(JSON.stringify(data)).toString('base64')}`;
}

async function collectFingerprintData() {
  return {
    p: 'Win32',
    l: 'en-US',
    hc: 8,
    dm: 16,
    to: -420,
    sw: 1920,
    sh: 1080,
    cd: 24,
    pr: 1,
    wf: 'ANGLE (Intel)',
    cf: cryptoHash(crypto.randomBytes(32).toString('hex')),
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

async function getBaxiaTokens() {
  if (browserBxUa && browserBxUmidToken) {
    return {
      bxUa: browserBxUa,
      bxUmidToken: browserBxUmidToken,
      bxV: BAXIA_VERSION,
    };
  }

  let bxUmidToken;
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': WEB_USER_AGENT },
    });
    bxUmidToken = resp.headers.get('etag') || `T2gA${randomString(40)}`;
  } catch {
    bxUmidToken = `T2gA${randomString(40)}`;
  }

  return {
    bxUa: encodeBaxiaToken(await collectFingerprintData()),
    bxUmidToken,
    bxV: BAXIA_VERSION,
  };
}

function baseHeaders(baxia, referer, extraCookie = '') {
  const requestId = uuidv4();
  const cookie = browserCookie || (extraCookie ? `token=${token}; ${extraCookie}` : `token=${token}`);
  return {
    Accept: referer.includes('/c/') && !referer.endsWith('/new-chat') ? 'application/json' : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'User-Agent': WEB_USER_AGENT,
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    source: 'web',
    'bx-ua': baxia.bxUa,
    'bx-umidtoken': baxia.bxUmidToken,
    'bx-v': baxia.bxV,
    cookie,
    Referer: referer,
    timezone: formatBrowserTimezone(),
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  };
}

function formatBrowserTimezone(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const minutes = String(absMinutes % 60).padStart(2, '0');
  return `${date.toDateString()} ${date.toTimeString().split(' ')[0]} GMT${sign}${hours}${minutes}`;
}

function normalizeSetCookie(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function createChat(baxia) {
  if (process.env.QWEN_DEBUG_CREATE_WITH_HISTORY === '1') {
    return createChatWithHistory(baxia);
  }

  const body = {
    title: 'SSE Debug',
    models: [model],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Date.now(),
    project_id: '',
  };

  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: baseHeaders(baxia, `${QWEN_BASE_URL}/c/new-chat`),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const data = safeJson(text);
  console.log('[createChat]', {
    status: resp.status,
    ok: resp.ok,
    contentType: resp.headers.get('content-type'),
    setCookie: Boolean(resp.headers.get('set-cookie')),
    body: redact(data || text.slice(0, 500)),
  });

  if (!resp.ok || !data?.success || !data?.data?.id) {
    throw new Error(`createChat failed: ${resp.status} ${text.slice(0, 500)}`);
  }

  return {
    chatId: data.data.id,
    cookie: normalizeSetCookie(resp.headers.get('set-cookie')),
  };
}

async function createChatWithHistory(baxia) {
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();
  const body = {
    title: 'SSE Debug',
    chat: {
      history: {
        currentId: assistantMessageId,
        currentResponseIds: [assistantMessageId],
        messages: {
          [userMessageId]: {
            fid: userMessageId,
            parentId: null,
            childrenIds: [assistantMessageId],
            role: 'user',
            content: prompt,
            user_action: 'chat',
            timestamp: Math.floor(Date.now() / 1000),
            models: [model],
            chat_type: 't2t',
            feature_config: {
              thinking_enabled: true,
              output_schema: 'phase',
              research_mode: 'normal',
              thinking_format: 'summary',
              auto_search: true,
            },
            extra: { meta: { subChatType: 't2t' } },
            sub_chat_type: 't2t',
          },
          [assistantMessageId]: {
            fid: assistantMessageId,
            parentId: userMessageId,
            childrenIds: [],
            role: 'assistant',
            content: '',
            model,
            modelName: model,
            modelIdx: 0,
            userContext: null,
            chat_type: 't2t',
            user_action: 'chat',
            merged: undefined,
            feature_config: {
              thinking_enabled: true,
              output_schema: 'phase',
              research_mode: 'normal',
              thinking_format: 'summary',
              auto_search: true,
            },
            extra: { meta: { subChatType: 't2t' } },
            timestamp: Math.floor(Date.now() / 1000),
            sub_chat_type: 't2t',
          },
        },
      },
      models: [model],
      messages: [],
    },
    chat_type: 't2t',
    models: [model],
    project_id: '',
  };

  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats`, {
    method: 'POST',
    headers: baseHeaders(baxia, `${QWEN_BASE_URL}/c/new-chat`),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const data = safeJson(text);
  console.log('[createChatWithHistory]', {
    status: resp.status,
    ok: resp.ok,
    contentType: resp.headers.get('content-type'),
    body: redact(data || text.slice(0, 1000)),
    userMessageId,
    assistantMessageId,
  });

  if (!resp.ok || !data?.success || !data?.data?.id) {
    throw new Error(`createChatWithHistory failed: ${resp.status} ${text.slice(0, 1000)}`);
  }

  return {
    chatId: data.data.id,
    cookie: normalizeSetCookie(resp.headers.get('set-cookie')),
    userMessageId,
    assistantMessageId,
  };
}

function buildCompletionPayload(chatId, ids = {}) {
  const messageFid = ids.userMessageId || uuidv4();
  const childId = ids.assistantMessageId || uuidv4();
  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: ids.parentId || null,
    messages: [
      {
        fid: messageFid,
        parentId: ids.parentId || null,
        childrenIds: [childId],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          thinking_budget: 81920,
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: ids.parentId || null,
      },
    ],
    timestamp: Math.floor(Date.now() / 1000),
  };
}

async function streamCompletion(baxia, chatId, cookie, ids = {}) {
  const completionBaxia = {
    ...baxia,
    bxUa: browserCompletionBxUa || baxia.bxUa,
  };
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, {
    method: 'POST',
    headers: baseHeaders(completionBaxia, `${QWEN_BASE_URL}/c/${chatId}`, cookie),
    body: JSON.stringify(buildCompletionPayload(chatId, ids)),
  });

  console.log('[completion]', {
    status: resp.status,
    ok: resp.ok,
    contentType: resp.headers.get('content-type'),
    transferEncoding: resp.headers.get('transfer-encoding'),
  });

  if (!resp.body) {
    console.log('[completion body]', (await resp.text()).slice(0, 2000));
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lineCount = 0;
  let parsedCount = 0;

  while (lineCount < maxLines) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      lineCount++;
      const data = parseLine(line);
      const parsed = data ? safeJson(data) : undefined;
      if (parsed) parsedCount++;
      console.log(`[line ${lineCount}]`, {
        raw: line.slice(0, 500),
        parsed: summarizeParsed(parsed),
      });
      if (lineCount >= maxLines) break;
    }
  }

  if (buffer.trim() && lineCount < maxLines) {
    lineCount++;
    const data = parseLine(buffer);
    console.log(`[line ${lineCount} buffered]`, {
      raw: buffer.slice(0, 500),
      parsed: summarizeParsed(data ? safeJson(data) : undefined),
    });
  }

  console.log('[summary]', { lineCount, parsedCount, remainingBufferLength: buffer.length });
  reader.releaseLock();
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
    error: parsed.error,
    responseCreated: parsed['response.created'] || parsed.response?.created,
    responseStatus: parsed.response?.status,
    choicesDelta: parsed.choices?.[0]?.delta,
    delta: parsed.delta,
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
    mode,
    model,
    promptLength: prompt.length,
    tokenPresent: Boolean(token),
    browserCookiePresent: Boolean(browserCookie),
    browserBaxiaPresent: Boolean(browserBxUa && browserBxUmidToken),
    browserCompletionBaxiaPresent: Boolean(browserCompletionBxUa),
    tokenPreview: `${token.slice(0, 4)}...${token.slice(-4)}`,
  });
  const baxia = await getBaxiaTokens();
  if (mode === 'assets') {
    await inspectFrontendAssets();
    return;
  }
  if (mode === 'discover') {
    await discoverEndpoints(baxia);
    return;
  }
  const chat = await createChat(baxia);
  console.log('[chat]', { chatId: chat.chatId, hasExtraCookie: Boolean(chat.cookie), chat });
  await streamCompletion(baxia, chat.chatId, chat.cookie, {
    userMessageId: chat.userMessageId,
    assistantMessageId: chat.assistantMessageId,
  });
  const { chatId, cookie } = chat;
  await inspectChatState(baxia, chatId, cookie);
}

async function inspectChatState(baxia, chatId, cookie) {
  const endpoints = [`/api/v2/chats/${chatId}`, `/api/v2/chats/${chatId}/messages`, `/api/v2/chats/${chatId}/history`];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(`${QWEN_BASE_URL}${endpoint}`, {
        headers: baseHeaders(baxia, `${QWEN_BASE_URL}/c/${chatId}`, cookie),
      });
      const text = await resp.text();
      console.log('[chat-state]', {
        endpoint,
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        body: redact(text.slice(0, 2000)),
      });
    } catch (err) {
      console.log('[chat-state:error]', { endpoint, message: err.message });
    }
  }
}

async function inspectFrontendAssets() {
  const resp = await fetch(QWEN_BASE_URL, { headers: { 'User-Agent': WEB_USER_AGENT } });
  const html = await resp.text();
  console.log('[html-snippet]', html.slice(0, 3000));
  const assets = [
    ...html.matchAll(/(?:src|href)=["']?([^"'\s>]+\.(?:js|mjs)[^"'\s>]*)["']?/g),
  ]
    .map((match) => new URL(match[1].startsWith('//') ? `https:${match[1]}` : match[1], QWEN_BASE_URL).toString())
    .slice(0, 30);
  console.log('[assets]', { status: resp.status, count: assets.length, assets });

  for (const asset of assets) {
    const assetResp = await fetch(asset, { headers: { 'User-Agent': WEB_USER_AGENT } });
    const text = await assetResp.text();
    const patterns = [
      '/api/v2/chat/completions',
      'feature_config',
      'childrenIds',
      'incremental_output',
      'user_action',
      'ResponseContentPhase.THINK',
    ];
    if (!patterns.some((pattern) => text.includes(pattern))) continue;
    console.log('[asset-match]', { asset, status: assetResp.status, length: text.length });
    for (const pattern of patterns) {
      const index = text.indexOf(pattern);
      if (index >= 0) {
        console.log(`[snippet:${pattern}]`, text.slice(Math.max(0, index - 1200), index + 2200));
      }
    }
    const userActionMatches = [...text.matchAll(/user_action[^,}]+/g)].slice(0, 12);
    userActionMatches.forEach((match, index) => {
      console.log(`[snippet:user_action_chat:${index}]`, text.slice(Math.max(0, match.index - 1600), match.index + 1800));
    });
  }
}

async function discoverEndpoints(baxia) {
  const endpoints = [
    '/api/v2/models',
    '/api/v2/models?chat_type=t2t',
    '/api/v2/chats/models',
    '/api/v2/config',
    '/api/v2/user/config',
    '/api/v2/chats/new',
  ];

  for (const endpoint of endpoints) {
    const method = endpoint.endsWith('/chats/new') ? 'POST' : 'GET';
    const body =
      method === 'POST'
        ? JSON.stringify({
            title: 'Discover Models',
            models: ['qwen3.6-plus'],
            chat_mode: 'normal',
            chat_type: 't2t',
            timestamp: Date.now(),
            project_id: '',
          })
        : undefined;
    try {
      const resp = await fetch(`${QWEN_BASE_URL}${endpoint}`, {
        method,
        headers: baseHeaders(baxia, `${QWEN_BASE_URL}/c/new-chat`),
        body,
      });
      const text = await resp.text();
      console.log('[discover]', {
        endpoint,
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        body: redact(text.slice(0, 3000)),
      });
    } catch (err) {
      console.log('[discover:error]', { endpoint, message: err.message });
    }
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
