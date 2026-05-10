// Run: npx tsx tests/e2e_reasoning.test.ts [API_KEY]
// Tests end-to-end reasoning/content separation via the backend API.
// The backend must be running: pnpm dev (default http://localhost:3000)

const BASE = process.env.API_BASE || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || process.argv[2] || '';

interface StreamChunk {
  content: string;
  reasoning: string;
  finishReason: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function post(url: string, body: unknown, _stream = false): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

async function nonStreaming(model: string): Promise<void> {
  console.log(`\n── Non-streaming [${model}] ──`);

  const res = await post(`${BASE}/v1/chat/completions`, {
    model,
    messages: [{ role: 'user', content: 'Chào bạn! (chỉ trả lời ngắn gọn)' }],
    stream: false,
  });

  const json: any = await res.json();
  const choice = json.choices?.[0];
  const msg = choice?.message;

  console.log(`  content:           "${JSON.stringify(msg?.content)?.slice(0, 120)}"`);
  console.log(`  reasoning_content: "${JSON.stringify(msg?.reasoning_content)?.slice(0, 200)}"`);

  // Assertions
  let pass = 0;
  let fail = 0;
  function assert(cond: boolean, label: string) {
    if (cond) {
      pass++;
      console.log(`  PASS: ${label}`);
    } else {
      fail++;
      console.error(`  FAIL: ${label}`);
    }
  }

  assert(typeof msg?.content === 'string' && msg.content.length > 0, 'content is non-empty string');
  assert(
    msg?.reasoning_content === undefined || typeof msg.reasoning_content === 'string',
    'reasoning_content is string if present',
  );
  assert(
    !msg?.content?.includes('người dùng') && !msg?.content?.includes('Tôi cần'),
    'content does not contain Vietnamese thinking patterns',
  );

  if (msg?.reasoning_content) {
    assert(!msg.reasoning_content.includes('Chào bạn'), 'reasoning_content does not contain greeting response');
  }

  console.log(`  → ${pass} passed, ${fail} failed`);
}

async function streaming(model: string): Promise<void> {
  console.log(`\n── Streaming [${model}] ──`);

  const res = await post(
    `${BASE}/v1/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: 'Chào bạn! (chỉ trả lời ngắn gọn)' }],
      stream: true,
    },
    true,
  );

  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: StreamChunk[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') break;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          chunks.push({
            content: delta.content || '',
            reasoning: delta.reasoning_content || '',
            finishReason: json.choices?.[0]?.finish_reason || null,
          });
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  const allContent = chunks.map((c) => c.content).join('');
  const allReasoning = chunks.map((c) => c.reasoning).join('');

  console.log(`  Total chunks: ${chunks.length}`);
  console.log(`  content:      "${allContent.slice(0, 120)}"`);
  console.log(`  reasoning:    "${allReasoning.slice(0, 200)}"`);

  let pass = 0;
  let fail = 0;
  function assert(cond: boolean, label: string) {
    if (cond) {
      pass++;
      console.log(`  PASS: ${label}`);
    } else {
      fail++;
      console.error(`  FAIL: ${label}`);
    }
  }

  assert(allContent.length > 0, 'stream content is non-empty');
  assert(
    !allContent.includes('người dùng') && !allContent.includes('Tôi cần'),
    'stream content does not contain thinking patterns',
  );

  const reasoningChunks = chunks.filter((c) => c.reasoning);
  if (reasoningChunks.length > 0) {
    console.log(`  Reasoning chunks: ${reasoningChunks.length}`);
    // At least some reasoning chunks should have empty content
    const pureReasoningChunks = reasoningChunks.filter((c) => !c.content);
    assert(pureReasoningChunks.length > 0, 'some reasoning chunks have empty content (separation works)');
  } else {
    console.log(`  (no reasoning chunks — model may not have emitted thinking)`);
  }

  // Verify no chunk contains both non-empty content AND reasoning in the wrong place
  for (const c of chunks) {
    if (c.content && c.reasoning) {
      // Both in same chunk is OK (first chunk can carry both from batch)
      // Just make sure reasoning isn't obviously a greeting
      if (c.reasoning.includes('Chào')) {
        assert(false, `reasoning should not contain greeting: "${c.reasoning.slice(0, 80)}"`);
      }
    }
  }

  console.log(`  → ${pass} passed, ${fail} failed`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('Usage: npx tsx tests/e2e_reasoning.test.ts <API_KEY>');
    console.error('   or: API_KEY=xxx npx tsx tests/e2e_reasoning.test.ts');
    process.exit(1);
  }

  console.log(`Backend: ${BASE}`);
  console.log(`API Key: ${API_KEY.slice(0, 8)}...`);

  // Health check
  try {
    const h = await fetch(`${BASE}/health`);
    const hb = await h.json();
    console.log(`Health:  ${JSON.stringify(hb)}`);
  } catch {
    console.error('Backend not reachable. Start with: pnpm dev');
    process.exit(1);
  }

  // Test with deepseek-chat (toggleable, default thinking on)
  await nonStreaming('deepseek-chat');
  await streaming('deepseek-chat');

  console.log('\n═══════════════════════════════════════');
  console.log('E2E tests complete.');
  console.log('Verify manually:');
  console.log('  1. reasoning_content should contain thinking (Vietnamese), NOT greetings');
  console.log('  2. content should contain the response, NOT thinking');
}

main().catch((e) => {
  console.error('E2E test error:', e.message);
  process.exit(1);
});
