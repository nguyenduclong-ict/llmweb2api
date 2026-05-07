// Run: npx tsx tests/stream_reasoning.test.ts
// Tests reasoningContent separation and ToolSieve streaming behavior.

import { ToolSieve } from '../providers/deepseek/tool_sieve';

// ── Replicate parseContent + helpers from index.ts for isolated testing ──

interface ParsedResult {
  content: string;
  reasoningContent?: string;
  nextType: string | null;
}

const SKIP_PATTERNS = [
  'status',
  'quasi_status',
  'elapsed_secs',
  'token_usage',
  'pending_fragment',
  'conversation_mode',
  'search_status',
];

function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some((p) => path.includes(p));
}

function isContentPath(p: string): boolean {
  return p.endsWith('/content') || p.includes('/content/');
}

function isThinkingPath(p: string): boolean {
  return p.endsWith('/thinking_content') || p.includes('/thinking_content/');
}

function extractTextValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return (obj.text as string) || (obj.content as string) || '';
  }
  return '';
}

function hasText(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

function parseFragments(fragments: Array<Record<string, unknown>>): {
  text: string;
  thinking: string;
  nextType: 'text' | 'thinking' | null;
} {
  let text = '';
  let thinking = '';
  let nextType: 'text' | 'thinking' | null = null;
  for (const frag of fragments) {
    const t = frag.type as string;
    const c = frag.content as string;
    if (!c) continue;
    if (t === 'THINK' || t === 'THINKING') {
      thinking += c;
      nextType = 'thinking';
    } else if (t === 'RESPONSE') {
      text += c;
      nextType = 'text';
    }
  }
  return { text, thinking, nextType };
}

function parseContent(chunk: Record<string, unknown>, currentFragmentType: string | null): ParsedResult | null {
  const path = chunk.p as string | undefined;
  const op = chunk.o as string | undefined;

  if (path && shouldSkip(path)) return null;

  if (path === 'response/fragments' && op === 'APPEND' && Array.isArray(chunk.v)) {
    const frags = chunk.v as Array<Record<string, unknown>>;
    const { text, thinking, nextType } = parseFragments(frags);
    if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
  }

  if (!path && !op && chunk.v && typeof chunk.v === 'object') {
    const vObj = chunk.v as Record<string, unknown>;
    const response = vObj.response as Record<string, unknown> | undefined;
    if (response?.fragments && Array.isArray(response.fragments)) {
      const { text, thinking, nextType } = parseFragments(response.fragments as Array<Record<string, unknown>>);
      if (text || thinking) return { content: text, reasoningContent: thinking || undefined, nextType };
    }
  }

  const text = extractTextValue(chunk.v);
  if (!text) return null;

  if (path && isContentPath(path)) {
    if (currentFragmentType === 'thinking') return { content: '', reasoningContent: text, nextType: 'thinking' };
    return { content: text, nextType: 'text' };
  }
  if (path && isThinkingPath(path)) return { content: '', reasoningContent: text, nextType: 'thinking' };

  if (!path && currentFragmentType) {
    return {
      content: currentFragmentType === 'thinking' ? '' : text,
      reasoningContent: currentFragmentType === 'thinking' ? text : undefined,
      nextType: currentFragmentType,
    };
  }

  return null;
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('\n========== parseFragments: THINKING + RESPONSE separation ==========');

// Test 1: Only THINKING
{
  const { text, thinking, nextType } = parseFragments([
    { type: 'THINKING', content: 'người dùng chỉ gửi lời chào. Tôi cần trả lời bằng tiếng Việt.' },
  ]);
  assertEq(text, '', 'THINKING only: text is empty');
  assertEq(
    thinking,
    'người dùng chỉ gửi lời chào. Tôi cần trả lời bằng tiếng Việt.',
    'THINKING only: thinking preserved',
  );
  assertEq(nextType, 'thinking', 'THINKING only: nextType = thinking');
}

// Test 2: Only RESPONSE
{
  const { text, thinking, nextType } = parseFragments([
    { type: 'RESPONSE', content: 'Chào bạn! Tôi có thể giúp gì cho bạn?' },
  ]);
  assertEq(text, 'Chào bạn! Tôi có thể giúp gì cho bạn?', 'RESPONSE only: text preserved');
  assertEq(thinking, '', 'RESPONSE only: thinking is empty');
  assertEq(nextType, 'text', 'RESPONSE only: nextType = text');
}

// Test 3: THINKING + RESPONSE in same batch
{
  const { text, thinking, nextType } = parseFragments([
    { type: 'THINKING', content: 'người dùng gửi "hello"' },
    { type: 'RESPONSE', content: 'Chào bạn!' },
  ]);
  assertEq(text, 'Chào bạn!', 'Mixed batch: text is response only');
  assertEq(thinking, 'người dùng gửi "hello"', 'Mixed batch: thinking is separated');
  assertEq(nextType, 'text', 'Mixed batch: nextType follows last fragment');
}

// Test 4: RESPONSE + THINKING order
{
  const { text, thinking, nextType } = parseFragments([
    { type: 'RESPONSE', content: 'Hello!' },
    { type: 'THINKING', content: 'wait, let me reconsider' },
  ]);
  assertEq(text, 'Hello!', 'RESPONSE+THINKING: text preserved');
  assertEq(thinking, 'wait, let me reconsider', 'RESPONSE+THINKING: thinking preserved');
  assertEq(nextType, 'thinking', 'RESPONSE+THINKING: nextType = thinking (last)');
}

// Test 5: Unicode Vietnamese text preserved
{
  const { text, thinking } = parseFragments([
    { type: 'THINKING', content: 'đây là tiếng Việt có dấu: ắ, ề, ố, ự, ỹ' },
    { type: 'RESPONSE', content: 'Xin chào bạn nhé!' },
  ]);
  assertEq(thinking, 'đây là tiếng Việt có dấu: ắ, ề, ố, ự, ỹ', 'Unicode: thinking diacritics preserved');
  assertEq(text, 'Xin chào bạn nhé!', 'Unicode: response preserved');
}

// Test 6: Empty fragments skipped
{
  const { text, thinking } = parseFragments([
    { type: 'THINKING', content: '' },
    { type: 'RESPONSE', content: 'valid' },
  ]);
  assertEq(text, 'valid', 'Empty THINKING skipped');
  assertEq(thinking, '', 'Empty THINKING produces no reasoning');
}

// Test 7: THINK type (alternative to THINKING)
{
  const { text, thinking } = parseFragments([
    { type: 'THINK', content: 'thinking content' },
    { type: 'RESPONSE', content: 'response content' },
  ]);
  assertEq(thinking, 'thinking content', 'THINK type: captured as reasoning');
  assertEq(text, 'response content', 'THINK type: response separated');
}

console.log('\n========== parseContent: streaming chunk processing ==========');

// Test 8: Batch fragment via response/fragments path
{
  const chunk = {
    p: 'response/fragments',
    o: 'APPEND',
    v: [
      { type: 'THINKING', content: 'model thinking...' },
      { type: 'RESPONSE', content: 'model response' },
    ],
  };
  const r = parseContent(chunk, null);
  assert(r !== null, 'Batch fragment: not null');
  if (r) {
    assertEq(r.content, 'model response', 'Batch: content = response only');
    assertEq(r.reasoningContent, 'model thinking...', 'Batch: reasoningContent = thinking');
    assertEq(r.nextType, 'text', 'Batch: nextType = text');
  }
}

// Test 9: Individual content path
{
  const chunk = { p: 'response/fragments/-1/content', o: 'APPEND', v: 'Xin chào' };
  const r = parseContent(chunk, null);
  assert(r !== null, 'Content path: not null');
  if (r) {
    assertEq(r.content, 'Xin chào', 'Content path: text');
    assertEq(r.reasoningContent, undefined, 'Content path: no reasoning');
  }
}

// Test 10: Individual thinking path
{
  const chunk = { p: 'response/fragments/-1/thinking_content', o: 'APPEND', v: 'suy nghĩ...' };
  const r = parseContent(chunk, null);
  assert(r !== null, 'Thinking path: not null');
  if (r) {
    assertEq(r.content, '', 'Thinking path: content empty');
    assertEq(r.reasoningContent, 'suy nghĩ...', 'Thinking path: reasoning preserved');
  }
}

// Test 11: Pathless chunk follows thinking (tracked type)
{
  const r = parseContent({ v: 'continued thinking' }, 'thinking');
  assert(r !== null, 'Pathless thinking: not null');
  if (r) {
    assertEq(r.content, '', 'Pathless thinking: content empty');
    assertEq(r.reasoningContent, 'continued thinking', 'Pathless thinking: added to reasoning');
  }
}

// Test 12: Pathless chunk follows text (tracked type)
{
  const r = parseContent({ v: 'continued response' }, 'text');
  assert(r !== null, 'Pathless text: not null');
  if (r) {
    assertEq(r.content, 'continued response', 'Pathless text: content');
    assertEq(r.reasoningContent, undefined, 'Pathless text: no reasoning');
  }
}

// Test 13: Nested response with fragments
{
  const chunk = {
    v: {
      response: {
        fragments: [
          { type: 'THINKING', content: 'nested thinking' },
          { type: 'RESPONSE', content: 'nested response' },
        ],
      },
    },
  };
  const r = parseContent(chunk, null);
  assert(r !== null, 'Nested: not null');
  if (r) {
    assertEq(r.content, 'nested response', 'Nested: content');
    assertEq(r.reasoningContent, 'nested thinking', 'Nested: reasoning');
  }
}

console.log('\n========== Full stream simulation ==========');

// Test 14: Simulate a complete "hello" stream with thinking + response
{
  const streamChunks = [
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [
        {
          type: 'THINKING',
          content: 'người dùng chỉ gửi lời chào "hello". Tôi cần trả lời ngắn gọn bằng tiếng Việt theo hướng dẫn.',
        },
      ],
    },
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [{ type: 'RESPONSE', content: 'Chào bạn! Tôi có thể giúp gì cho bạn?' }],
    },
  ];

  let currentFragmentType: string | null = null;
  const collected: Array<{ content: string; reasoning: string }> = [];

  for (const chunk of streamChunks) {
    const r = parseContent(chunk, currentFragmentType);
    if (r) {
      currentFragmentType = r.nextType;
      if (r.content || r.reasoningContent) {
        if (r.content) {
          collected.push({ content: r.content, reasoning: r.reasoningContent || '' });
        } else if (hasText(r.reasoningContent)) {
          collected.push({ content: '', reasoning: r.reasoningContent });
        }
      }
    }
  }

  assertEq(collected.length, 2, 'Full stream: 2 chunks emitted');
  assertEq(collected[0].content, '', 'Full stream chunk 1: content empty');
  assertEq(
    collected[0].reasoning,
    'người dùng chỉ gửi lời chào "hello". Tôi cần trả lời ngắn gọn bằng tiếng Việt theo hướng dẫn.',
    'Full stream chunk 1: reasoning preserved',
  );
  assertEq(collected[1].content, 'Chào bạn! Tôi có thể giúp gì cho bạn?', 'Full stream chunk 2: response text');
  assertEq(collected[1].reasoning, '', 'Full stream chunk 2: no reasoning');
}

// Test 15: Single batch with both THINKING + RESPONSE
{
  const chunk = {
    p: 'response/fragments',
    o: 'APPEND',
    v: [
      { type: 'THINKING', content: 'thinking part' },
      { type: 'RESPONSE', content: 'response part' },
    ],
  };
  const r = parseContent(chunk, null);
  assert(r !== null, 'Combined batch: not null');
  if (r) {
    assertEq(r.content, 'response part', 'Combined batch: content = response');
    assertEq(r.reasoningContent, 'thinking part', 'Combined batch: reasoning = thinking');
    // In stream loop, reasoning is attached to first content yield
    assert(r.content !== '' && r.reasoningContent !== undefined, 'Combined batch: both content and reasoning set');
  }
}

// Test 16: Thinking continuation via /content path (the real DeepSeek bug)
{
  // Simulate real stream: first batch sets currentFragmentType='thinking',
  // then subsequent chunks come through response/fragments/-1/content
  const streamChunks: Array<Record<string, unknown>> = [
    // Batch: THINK fragment starts
    { v: { response: { fragments: [{ type: 'THINK', content: 'We' }] } } },
    // Thinking continues via /content path (NOT /thinking_content)
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '" need"' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: ' to' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: ' respond' },
    // Pathless chunk ─ should still be thinking
    { v: ' in Vietnamese.' },
    // Now RESPONSE fragment
    { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'Chào bạn!' }] },
  ];

  let currentFragmentType: string | null = null;
  const collected: Array<{ content: string; reasoning: string }> = [];

  for (const chunk of streamChunks) {
    const r = parseContent(chunk, currentFragmentType);
    if (r) {
      currentFragmentType = r.nextType;
      if (r.content || r.reasoningContent) {
        collected.push({ content: r.content, reasoning: r.reasoningContent || '' });
      }
    }
  }

  // All thinking chunks should have empty content, reasoning populated
  const allReasoning = collected
    .filter((c) => c.reasoning)
    .map((c) => c.reasoning)
    .join('');
  const allContent = collected
    .filter((c) => c.content)
    .map((c) => c.content)
    .join('');

  assertEq(allReasoning, 'We" need" to respond in Vietnamese.', 'Content-path thinking: all reasoning accumulated');
  assertEq(allContent, 'Chào bạn!', 'Content-path thinking: content has response only');
  assertEq(collected.length, 6, 'Content-path thinking: 6 chunks emitted');

  // First chunk: batch with THINK, content empty, reasoning = "We"
  assertEq(collected[0].content, '', 'Content-path chunk 1: content empty');
  assertEq(collected[0].reasoning, 'We', 'Content-path chunk 1: reasoning = We');

  // Second chunk: /content path but thinking, should go to reasoning
  assertEq(collected[1].content, '', 'Content-path chunk 2: content empty (thinking)');
  assertEq(collected[1].reasoning, '" need"', 'Content-path chunk 2: reasoning via content path');
}

console.log('\n========== ToolSieve: no false positives on normal text ==========');

// Test 16: Normal text passes through sieve
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('Xin chào bạn!');
  assertEq(events.length, 1, 'Sieve: 1 event for normal text');
  assertEq(events[0].type, 'content', 'Sieve: event type = content');
  assertEq(events[0].text, 'Xin chào bạn!', 'Sieve: text preserved exactly');
}

// Test 17: Vietnamese text with brackets
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('Tôi sẽ trả lời: [xin chào]');
  assertEq(events.length, 1, 'Sieve brackets: 1 event');
  assertEq(events[0].type, 'content', 'Sieve brackets: type = content');
  assertEq(events[0].text, 'Tôi sẽ trả lời: [xin chào]', 'Sieve brackets: text preserved with brackets');
}

// Test 18: Text ending with [ (partial marker)
{
  const sieve = new ToolSieve();
  const events1 = sieve.processChunk('text ending with [');
  // The [ might be held as partial, so text before it should be emitted
  const hasContent = events1.some((e) => e.type === 'content');
  assert(hasContent, 'Sieve partial: content before [ is emitted');

  const events2 = sieve.processChunk('not a marker]');
  const content = events2
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(content, '[not a marker]', 'Sieve partial: [ is re-emitted with next chunk');
}

// Test 19: Text with [# but not full marker
{
  const sieve = new ToolSieve();
  // "[#" is a partial marker, might be held
  sieve.processChunk('see [#');
  const events2 = sieve.processChunk('not a tool call');
  const content = events2
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(content, '[#not a tool call', 'Sieve: [# re-emitted with next chunk');
}

// Test 20: Flush emits remaining content
{
  const sieve = new ToolSieve();
  sieve.processChunk('hello');
  const events = sieve.flush();
  // After processing, buffer should be empty, flush returns empty
  assertEq(events.length, 0, 'Sieve flush: no pending content after complete chunk');
}

// Test 21: Flush with partial buffer
{
  const sieve = new ToolSieve();
  sieve.processChunk('text with [');
  const events = sieve.flush();
  const content = events
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assert(content.includes('['), 'Sieve flush: partial marker emitted on flush');
}

console.log('\n========== ToolSieve: unknown [#llmweb2api:*] blocks ==========');

// Test 22: Unknown block markers stripped, content preserved (newlines included)
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('[#llmweb2api:question]\nCâu hỏi của tôi\n[$llmweb2api:question]');
  assertEq(events.length, 1, 'Unknown block: 1 event');
  assertEq(events[0].type, 'content', 'Unknown block: type = content');
  assertEq(events[0].text, '\nCâu hỏi của tôi\n', 'Unknown block: markers stripped, inner text preserved');
}

// Test 23: Unknown block with text before and after
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('hello [#llmweb2api:question]\ntest\n[$llmweb2api:question] bye');
  assertEq(events.length, 3, 'Unknown block: 3 events (pre + inner + post)');
  assertEq(events[0].text, 'hello ', 'Unknown block: text before');
  assertEq(events[1].text, '\ntest\n', 'Unknown block: inner content');
  assertEq(events[2].text, ' bye', 'Unknown block: text after emitted immediately');
}

// Test 24: Unknown block streaming (split across chunks)
{
  const sieve = new ToolSieve();
  const e1 = sieve.processChunk('text [#llmweb2api:quest'); // partial
  assertEq(e1.length, 1, 'Streaming unknown: pre-text emitted');
  assertEq(e1[0].text, 'text ', 'Streaming unknown: pre-text');

  const e2 = sieve.processChunk('ion]\ninner content\n[$llmweb2api:quest');
  // Partial end marker → inner content emitted, partial held
  const innerContent = e2.filter((e) => e.type === 'content').map((e) => e.text).join('');
  assertEq(innerContent, '\ninner content\n', 'Streaming unknown: inner content emitted before partial end');

  const e3 = sieve.processChunk('ion] after');
  const afterContent = e3.filter((e) => e.type === 'content').map((e) => e.text).join('');
  assertEq(afterContent, ' after', 'Streaming unknown: text after block');
}

// Test 25: Unknown block then tool_call (both handled)
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk(
    '[#llmweb2api:question]\nwhat?\n[$llmweb2api:question]\n' +
    '[#llmweb2api:tool_call]\n```yaml\nname: test_fn\narguments:\n  x: 1\n```\n[$llmweb2api:tool_call]',
  );
  const contentEvents = events.filter((e) => e.type === 'content');
  const toolEvents = events.filter((e) => e.type === 'tool_calls');
  assert(contentEvents.length >= 1, 'Mixed: has content from unknown block');
  assertEq(toolEvents.length, 1, 'Mixed: 1 tool_call event');
  assertEq(toolEvents[0].toolCalls?.[0]?.name, 'test_fn', 'Mixed: tool_call correctly parsed');
}

// Test 26: Unknown block without closing → emitted as-is on flush
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('[#llmweb2api:question]\nunclosed content');
  // Should still be waiting for end marker
  const flushed = sieve.flush();
  const flushedText = flushed.filter((e) => e.type === 'content').map((e) => e.text).join('');
  assert(flushedText.includes('[#llmweb2api:question]'), 'Unclosed unknown: emits markers on flush');
  assert(flushedText.includes('unclosed content'), 'Unclosed unknown: emits content on flush');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
