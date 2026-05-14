const BASE = process.env.ZAI_BASE_URL || 'https://chat.z.ai';
const FE_VERSION = process.env.ZAI_FE_VERSION || 'prod-fe-1.0.76';

const browserHeaders = {
  'User-Agent':
    process.env.ZAI_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'X-FE-Version': FE_VERSION,
  'sec-ch-ua': '"Not;A=Brand";v="99", "Edge";v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  Origin: BASE,
};

async function main(): Promise<void> {
  const prompt = getArg('--prompt') || 'hi';
  const model = getArg('--model') || process.env.ZAI_MODEL || 'GLM-4.5';
  const path = getArg('--path') || '/api/chat/completions';
  const maxChunks = Number(getArg('--max-chunks') || '20');
  const timeoutMs = Number(getArg('--timeout-ms') || '120000');
  const token = await getAnonymousToken(timeoutMs);
  const chatId = createId('chat');
  const messageId = createId('msg');

  const body = {
    stream: true,
    chat_id: chatId,
    id: messageId,
    model,
    messages: [{ role: 'user', content: prompt }],
    features: { enable_thinking: true },
  };

  console.log(`[ZAI_ANON] base=${BASE}`);
  console.log(`[ZAI_ANON] path=${path}`);
  console.log(`[ZAI_ANON] model=${model} prompt=${JSON.stringify(prompt)}`);
  console.log(`[ZAI_ANON] token=${token.slice(0, 24)}... chatId=${chatId} messageId=${messageId}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        ...browserHeaders,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Referer: `${BASE}/c/${chatId}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    console.log(`[ZAI_ANON] status=${response.status} ${response.statusText}`);
    console.log(`[ZAI_ANON] content-type=${response.headers.get('content-type') || '<none>'}`);

    if (!response.ok) {
      console.log(`[ZAI_ANON] error body=${(await response.text()).slice(0, 4000)}`);
      return;
    }

    if (!response.body) {
      console.log(await response.text());
      return;
    }
    await readSse(response.body, maxChunks);
  } finally {
    clearTimeout(timer);
  }
}

async function getAnonymousToken(timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}/api/v1/auths/`, {
      method: 'GET',
      headers: browserHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    console.log(`[ZAI_ANON] auth status=${response.status} ${response.statusText}`);
    if (!response.ok) throw new Error(`Anonymous auth failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
    const data = JSON.parse(text) as { token?: string };
    if (!data.token) throw new Error(`Anonymous auth response missing token: ${text.slice(0, 1000)}`);
    return data.token;
  } finally {
    clearTimeout(timer);
  }
}

async function readSse(body: ReadableStream<Uint8Array>, maxChunks: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let parsed = 0;
  let contentChars = 0;
  let reasoningChars = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (!data || data === '[DONE]') continue;
        parsed += 1;
        console.log(`[ZAI_ANON] event ${parsed}: ${data.slice(0, 2000)}`);
        try {
          const payload = JSON.parse(data) as { data?: { phase?: string; delta_content?: string; done?: boolean } };
          const delta = payload.data?.delta_content || '';
          if (payload.data?.phase === 'thinking') reasoningChars += delta.length;
          if (payload.data?.phase === 'answer') contentChars += delta.length;
          if (payload.data?.done) {
            console.log('[ZAI_ANON] done event received');
            return;
          }
        } catch {
          // Keep printing raw events; parse failures are useful while reverse engineering.
        }
        if (parsed >= maxChunks) {
          console.log(`[ZAI_ANON] max events reached (${maxChunks}), cancelling reader`);
          await reader.cancel();
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  console.log(`[ZAI_ANON] parsed=${parsed} contentChars=${contentChars} reasoningChars=${reasoningChars}`);
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

main().catch((err) => {
  console.error(`[ZAI_ANON] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exitCode = 1;
});
