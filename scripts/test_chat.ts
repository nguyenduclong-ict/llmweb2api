/**
 * Script tái hiện bug: message 1 OK, message 2 không response.
 * Usage: npx tsx scripts/test_chat.ts
 */
const API = 'http://localhost:3500/v1/chat/completions';
const KEY = 'sk-9agnnpup2yuom2ws2r0r29o7qsbjt0us8jbg6dqr8g68bhr5';

async function chat(messages: Array<{ role: string; content: string }>, conversationId?: string) {
  const body: Record<string, unknown> = {
    model: 'gpt-4o',
    messages,
    stream: true,
  };
  if (conversationId) {
    body.conversation_id = conversationId;
  }

  console.log(`\n=== REQUEST (convId=${conversationId || 'new'}) ===`);
  console.log(`Messages: ${messages.map((m) => `${m.role}: ${m.content.slice(0, 50)}`).join(' | ')}`);

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });

  console.log(`Status: ${res.status}`);

  let convId = '';
  let fullContent = '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log(`[DONE] chunks=${chunkCount} contentLen=${fullContent.length}`);
        continue;
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (choice?.delta?.content) {
          fullContent += choice.delta.content;
          chunkCount++;
        }
      } catch {}
    }
  }

  // Extract conversation_id from SSE (first chunk usually has it)
  // Actually, let's re-read the response to get conversation_id
  // We'll get it from the stream chunks

  return { conversationId: convId, content: fullContent, chunkCount };
}

async function main() {
  console.log('=== Test 1: Message đầu "hello" ===');
  const r1 = await chat([{ role: 'user', content: 'Hello, say hi back in one word.' }]);
  console.log(`Result: content="${r1.content.slice(0, 100)}" chunks=${r1.chunkCount}`);

  if (!r1.content) {
    console.log('FAIL: Message 1 got no response!');
    return;
  }

  // We need conversationId to continue. The API puts it in the JSON response.
  // Let me check the response format more carefully.
  console.log('\n=== Getting conversationId from non-stream request ===');
  const res2 = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    }),
  });
  const json2 = await res2.json() as any;
  const convId = json2.conversation_id || json2.conversationId || '';
  console.log(`convId from non-stream: "${convId}"`);
  console.log(`content: "${json2.choices?.[0]?.message?.content?.slice(0, 100)}"`);

  if (!convId) {
    console.log('FAIL: No conversationId returned!');
    return;
  }

  console.log('\n=== Test 2: Message 2 với conversationId ===');
  const r2 = await chat(
    [{ role: 'user', content: 'Tell me what is 2+2? Answer in one sentence.' }],
    convId,
  );
  console.log(`Result: content="${r2.content.slice(0, 200)}" chunks=${r2.chunkCount}`);

  if (!r2.content) {
    console.log('\nBUG REPRODUCED: Message 2 got empty response!');
  } else {
    console.log('\nOK: Both messages got responses.');
  }
}

main().catch(console.error);
