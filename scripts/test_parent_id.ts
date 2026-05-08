/**
 * Test: msg2 dùng parent = request_message_id (của user msg1)
 *             vs parent = response_message_id (của assistant)
 *
 * Giả thuyết: nếu parent = request_message_id của msg1,
 * assistant1 sẽ bị mất khỏi cây hội thoại.
 *
 * Usage: npx tsx --env-file=.env scripts/test_parent_id.ts
 */
import { login, createSession, getPow } from '../src/providers/deepseek/client.js';
import axios from 'axios';
import { DEEPSEEK_URLS, BASE_HEADERS } from '../src/providers/deepseek/types.js';

function authHeaders(token: string) {
  return { ...BASE_HEADERS, Authorization: `Bearer ${token}` };
}

interface ChatResult {
  text: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
}

async function sendMessage(
  token: string,
  sessionId: string,
  prompt: string,
  parentMessageId: number | null,
): Promise<ChatResult> {
  const { powResponse } = await getPow(token);

  const payload = {
    chat_session_id: sessionId,
    parent_message_id: parentMessageId,
    model_type: 'default',
    prompt,
    search_enabled: true,
    ref_file_ids: [],
  };

  const label = parentMessageId === null ? 'null' : String(parentMessageId);
  console.log(`[SEND] parent=${label} prompt="${prompt.slice(0, 80)}..."`);

  const resp = await axios.post(DEEPSEEK_URLS.completion, payload, {
    headers: { ...authHeaders(token), 'x-ds-pow-response': powResponse },
    responseType: 'stream',
    validateStatus: () => true,
  });

  if (resp.status !== 200) {
    let body = '';
    try {
      for await (const chunk of resp.data) { body += chunk.toString(); if (body.length > 500) break; }
    } catch {}
    console.log(`[ERROR] HTTP ${resp.status}: ${body.slice(0, 300)}`);
    throw new Error(`HTTP ${resp.status}`);
  }

  const stream = resp.data;
  let buffer = '';
  let text = '';
  let requestMessageId: number | null = null;
  let responseMessageId: number | null = null;

  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;

      try {
        const json = JSON.parse(raw);
        if (json.request_message_id) requestMessageId = json.request_message_id;
        if (json.response_message_id) responseMessageId = json.response_message_id;

        if (typeof json.content === 'string') {
          text += json.content;
        } else if (json.v?.response?.fragments) {
          for (const frag of json.v.response.fragments) {
            if (typeof frag.content === 'string') text += frag.content;
          }
        } else if (json.v?.response?.content) {
          text += json.v.response.content;
        }
      } catch {}
    }
  }

  if (buffer.startsWith('data:')) {
    try {
      const json = JSON.parse(buffer.slice(5).trim());
      if (json.request_message_id) requestMessageId = json.request_message_id;
      if (json.response_message_id) responseMessageId = json.response_message_id;
    } catch {}
  }

  console.log(`[RECV] len=${text.length} reqId=${requestMessageId} respId=${responseMessageId} text="${text.slice(0, 120)}"`);
  return { text, requestMessageId, responseMessageId };
}

function checkResult(text: string, expectedAnswer: string): 'match' | 'wrong' | 'dont_know' {
  if (text.toLowerCase().includes(expectedAnswer.toLowerCase())) return 'match';
  if (text.toLowerCase().includes("don't remember") || text.toLowerCase().includes('dont remember') ||
      text.toLowerCase().includes("don't know") || text.toLowerCase().includes('forgot') ||
      text.toLowerCase().includes('not sure')) return 'dont_know';
  return 'wrong';
}

async function main() {
  const email = process.env.DEEPSEEK_EMAIL;
  const password = process.env.DEEPSEEK_PASSWORD;

  if (!email || !password) {
    console.log('ERROR: Set DEEPSEEK_EMAIL and DEEPSEEK_PASSWORD in .env file.');
    return;
  }

  console.log('=== Test: parent = msg1.reqId vs parent = msg1.respId ===\n');

  const token = await login(email, password);

  // ── Session A: msg2 parent = requestMessageId của msg1 (SAI) ──
  console.log('='.repeat(60));
  console.log('=== Session A: msg2 parent = REQUEST_MESSAGE_ID của msg1 (SAI) ===');
  console.log('='.repeat(60));

  const sessionA = await createSession(token);
  console.log(`  => Session ID: ${sessionA}`);

  const answer1 = 'blue';
  const r1a = await sendMessage(
    token, sessionA,
    `My favorite color is ${answer1}. Just reply "Got it, your favorite color is ${answer1}."`,
    null,
  );
  if (!r1a.text) { console.log('FAIL: Msg1 no response'); return; }
  console.log(`  => Assistant response ID: ${r1a.responseMessageId}`);

  // Dùng requestMessageId của msg1 làm parent (SAI)
  console.log(`\n!!! Dùng parent = requestMessageId của msg1 = ${r1a.requestMessageId} (SAI)`);
  const r2a = await sendMessage(
    token, sessionA,
    `What is my favorite color? Reply with just the color, or "I forgot" if you dont know.`,
    r1a.requestMessageId,  // <-- SAI: dùng reqId thay vì respId
  );

  const resultA = checkResult(r2a.text, answer1);
  console.log(`\n--- KẾT QUẢ Session A ---`);
  console.log(`  Msg1 -> Assistant (respId=${r1a.responseMessageId}): "${r1a.text}"`);
  console.log(`  Msg2 (parent=reqId=${r1a.requestMessageId}): "${r2a.text}"`);
  console.log(`  => ${resultA === 'match' ? 'NHỚ' : resultA === 'dont_know' ? 'QUÊN / KHÔNG BIẾT' : 'TRẢ LỜI SAI'}`);

  // ── Session B: msg2 parent = responseMessageId của msg1 (ĐÚNG) ──
  console.log('\n' + '='.repeat(60));
  console.log('=== Session B: msg2 parent = RESPONSE_MESSAGE_ID của assistant (ĐÚNG) ===');
  console.log('='.repeat(60));

  const sessionB = await createSession(token);
  console.log(`  => Session ID: ${sessionB}`);

  const answer2 = 'green';
  const r1b = await sendMessage(
    token, sessionB,
    `My favorite color is ${answer2}. Just reply "Got it, your favorite color is ${answer2}."`,
    null,
  );
  if (!r1b.text) { console.log('FAIL: Msg1 no response'); return; }
  console.log(`  => Assistant response ID: ${r1b.responseMessageId}`);

  console.log(`\n!!! Dùng parent = responseMessageId của assistant = ${r1b.responseMessageId} (ĐÚNG)`);
  const r2b = await sendMessage(
    token, sessionB,
    `What is my favorite color? Reply with just the color, or "I forgot" if you dont know.`,
    r1b.responseMessageId,  // <-- ĐÚNG: dùng respId
  );

  const resultB = checkResult(r2b.text, answer2);
  console.log(`\n--- KẾT QUẢ Session B ---`);
  console.log(`  Msg1 -> Assistant (respId=${r1b.responseMessageId}): "${r1b.text}"`);
  console.log(`  Msg2 (parent=respId=${r1b.responseMessageId}): "${r2b.text}"`);
  console.log(`  => ${resultB === 'match' ? 'NHỚ' : resultB === 'dont_know' ? 'QUÊN / KHÔNG BIẾT' : 'TRẢ LỜI SAI'}`);

  // ── Tổng kết ──
  console.log('\n' + '='.repeat(60));
  console.log('=== TỔNG KẾT ===');
  console.log(`Session A (parent=reqId):  ${resultA === 'match' ? 'NHỚ' : 'MẤT CONTEXT'} (assistant bị ghi đè)`);
  console.log(`Session B (parent=respId): ${resultB === 'match' ? 'NHỚ' : 'MẤT CONTEXT'}`);
  console.log(`\n=> Kết luận: ${resultA === 'match' ? 'CÓ THỂ dùng reqId' : 'PHẢI dùng respId, nếu không assistant bị mất'}`);
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
});
