const BASE = 'http://localhost:3000';

const NO_CACHE_KEY = 'sk-z642ust4we4k4zs8ejuizl0ibjfvf6ppwfzscacdfo4rmyyw';
const CACHE_KEY = 'sk-9agnnpup2yuom2ws2r0r29o7qsbjt0us8jbg6dqr8g68bhr5';

const CASES = [
  // { label: 'NO_CACHE stream=false', key: NO_CACHE_KEY, stream: false },
  // { label: 'NO_CACHE stream=true', key: NO_CACHE_KEY, stream: true },
  { label: 'CACHE stream=false', key: CACHE_KEY, stream: false },
  // { label: 'CACHE stream=true', key: CACHE_KEY, stream: true },
];

async function testCase({ label, key, stream }) {
  console.log(`\n=== ${label} ===`);
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      {
        role: 'user',
        content:
          'Say hello in one short sentence' + (stream ? ' and explain briefly how you came up with that answer.' : ''),
      },
    ],
    stream,
    max_tokens: 200,
  };

  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    console.log(`  Status: ${resp.status}`);

    if (stream) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let count = 0;
      let fullContent = '';
      let fullReasoning = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const json = trimmed.slice(6);
          if (json === '[DONE]') continue;
          try {
            const chunk = JSON.parse(json);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              count++;
            }
            if (delta?.reasoning_content) {
              fullReasoning += delta.reasoning_content;
            }
          } catch {}
        }
      }
      console.log(`  Chunks: ${count}`);
      console.log(`  Content: "${fullContent.slice(0, 200)}"`);
      if (fullReasoning) console.log(`  Reasoning: "${fullReasoning.slice(0, 200)}"`);
    } else {
      const json = await resp.json();
      const msg = json.choices?.[0]?.message;
      console.log(`  Content: "${msg?.content?.slice(0, 200) || ''}"`);
      if (msg?.reasoning_content) console.log(`  Reasoning: "${msg.reasoning_content.slice(0, 200)}"`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

for (const c of CASES) {
  await testCase(c);
}

console.log('\nDONE');
