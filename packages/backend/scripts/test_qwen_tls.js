// Run this script while the dev server is running with tsx watch
// It will retry until the server picks up the new code
const http = require('http');

const API_KEY = 'sk-9agnnpup2yuom2ws2r0r29o7qsbjt0us8jbg6dqr8g68bhr5';
const HOST = 'localhost';
const PORT = 3000;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 30000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function testNonStream() {
  console.log('[TEST] Non-stream chat completion...');
  const res = await post('/v1/chat/completions', {
    model: 'qwen3.6-plus',
    messages: [{ role: 'user', content: 'Say exactly: hello world' }],
    stream: false,
  });
  console.log(`  Status: ${res.status}`);
  if (res.status === 200) {
    try {
      const j = JSON.parse(res.body);
      const reply = j.choices?.[0]?.message?.content || '';
      console.log(`  Reply: ${reply.slice(0, 200)}`);
      return reply.toLowerCase().includes('hello world');
    } catch (e) {
      console.log(`  Parse error: ${e.message}`);
      return false;
    }
  }
  console.log(`  Error: ${res.body.slice(0, 500)}`);
  return false;
}

async function testStream() {
  console.log('[TEST] Stream chat completion...');
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Count: 1, 2, 3' }],
      stream: true,
    });
    const t0 = Date.now();
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 60000,
      },
      (res) => {
        let raw = '';
        let firstChunkAt = 0;
        let chunkCount = 0;
        res.on('data', (chunk) => {
          if (!firstChunkAt) firstChunkAt = Date.now();
          raw += chunk.toString();
          chunkCount++;
        });
        res.on('end', () => {
          const elapsed = Date.now() - t0;
          const ttfb = firstChunkAt - t0;
          console.log(`  Status: ${res.status}, TTFB: ${ttfb}ms, total: ${elapsed}ms, chunks: ${chunkCount}`);
          const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
          console.log(`  SSE data lines: ${lines.length}`);
          if (chunkCount > 1 && ttfb < 10000) {
            console.log('  [OK] Realtime stream working');
            resolve(true);
          } else {
            console.log(`  [WARN] Slow/buffered: TTFB=${ttfb}ms, chunks=${chunkCount}`);
            resolve(res.status === 200 && lines.length > 0);
          }
        });
      },
    );
    req.on('error', (e) => {
      console.log(`  Error: ${e.message}`);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      console.log('  Timeout');
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function testMultiTurn() {
  console.log('[TEST] Multi-turn conversation...');
  const res1 = await post('/v1/chat/completions', {
    model: 'qwen3.6-plus',
    messages: [{ role: 'user', content: 'My secret word is "pineapple". Just reply OK.' }],
    stream: false,
  });
  if (res1.status !== 200) {
    console.log(`  Turn 1 failed: ${res1.status} ${res1.body.slice(0, 300)}`);
    return false;
  }
  const j1 = JSON.parse(res1.body);
  const convId = j1.conversation_id || j1.id;
  console.log(`  Turn 1 convId: ${convId}`);

  const res2 = await post('/v1/chat/completions', {
    model: 'qwen3.6-plus',
    messages: [{ role: 'user', content: 'What was my secret word?' }],
    stream: false,
    conversation_id: convId,
  });
  if (res2.status !== 200) {
    console.log(`  Turn 2 failed: ${res2.status} ${res2.body.slice(0, 300)}`);
    return false;
  }
  const j2 = JSON.parse(res2.body);
  const reply = j2.choices?.[0]?.message?.content || '';
  console.log(`  Turn 2 reply: ${reply.slice(0, 200)}`);
  const passed = reply.toLowerCase().includes('pineapple');
  console.log(passed ? '  [OK] Multi-turn memory works!' : '  [FAIL] Multi-turn memory broken');
  return passed;
}

async function main() {
  for (let i = 1; i <= 10; i++) {
    console.log(`\n=== Round ${i}/10 (waiting for server restart) ===`);

    const ns = await testNonStream();
    if (!ns) {
      console.log('[RETRY] Waiting 3s for server to load new code...');
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const stream = await testStream();
    if (!stream) {
      console.log('[RETRY] Stream test...');
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const mt = await testMultiTurn();
    if (!mt) {
      console.log('[RETRY] Multi-turn test...');
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
  }
  console.log('\n=== MAX ROUNDS REACHED ===');
  process.exit(1);
}

main();
