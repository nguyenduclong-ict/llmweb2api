// Run: npx tsx tests/stream_reasoning.test.ts
// Tests reasoningContent separation and ToolSieve streaming behavior.

import { ToolSieve } from '../providers/core/tool_sieve';

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
    assert(r.content !== '' && r.reasoningContent !== undefined, 'Combined batch: both content and reasoning set');
  }
}

// Test 16: Thinking continuation via /content path (the real DeepSeek bug)
{
  const streamChunks: Array<Record<string, unknown>> = [
    { v: { response: { fragments: [{ type: 'THINK', content: 'We' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '" need"' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: ' to' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: ' respond' },
    { v: ' in Vietnamese.' },
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

  assertEq(collected[0].content, '', 'Content-path chunk 1: content empty');
  assertEq(collected[0].reasoning, 'We', 'Content-path chunk 1: reasoning = We');

  assertEq(collected[1].content, '', 'Content-path chunk 2: content empty (thinking)');
  assertEq(collected[1].reasoning, '" need"', 'Content-path chunk 2: reasoning via content path');
}

console.log('\n========== ToolSieve: no false positives on normal text ==========');

// Test 17: Normal text passes through sieve
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('Xin chào bạn!');
  assertEq(events.length, 1, 'Sieve: 1 event for normal text');
  assertEq(events[0].type, 'content', 'Sieve: event type = content');
  assertEq(events[0].text, 'Xin chào bạn!', 'Sieve: text preserved exactly');
}

// Test 18: Vietnamese text with angle brackets
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('Tôi sẽ trả lời: <xin chào>');
  assertEq(events.length, 1, 'Sieve angle brackets: 1 event');
  assertEq(events[0].type, 'content', 'Sieve angle brackets: type = content');
  assertEq(events[0].text, 'Tôi sẽ trả lời: <xin chào>', 'Sieve angle brackets: text passed through (not [#l2a:)');
}

// Test 19: Text ending with [ (partial of [#l2a but NOT at line start)
{
  const sieve = new ToolSieve();
  const events1 = sieve.processChunk('text ending with [');
  // [ is a partial but NOT at line start → not held, entire text emitted
  const contentText = events1
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(contentText, 'text ending with [', 'Sieve partial: full text emitted (partial not at line start)');

  const events2 = sieve.processChunk('rest');
  const content2 = events2
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(content2, 'rest', 'Sieve partial: next chunk emitted as-is');
}

// Test 20: Text with [#l2a: but not at line start
{
  const sieve = new ToolSieve();
  sieve.processChunk('see [#l2a:user]');
  const events2 = sieve.processChunk(' content[/l2a:user] end');
  // [#l2a:user] is NOT at line start → passes through as content
  const content = events2
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(content, ' content[/l2a:user] end', 'Sieve: inline [#l2a:] not detected (not at line start)');
}

// Test 21: Flush emits remaining content
{
  const sieve = new ToolSieve();
  sieve.processChunk('hello');
  const events = sieve.flush();
  assertEq(events.length, 0, 'Sieve flush: no pending content after complete chunk');
}

// Test 22: Flush with partial buffer
{
  const sieve = new ToolSieve();
  sieve.processChunk('text\n[#l2a');
  // [#l2a at line start is a partial of [#l2a:... — held in buffer
  const events = sieve.flush();
  const content = events
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assert(content.includes('[#l2a'), 'Sieve flush: partial [#l2a emitted on flush');
}

console.log('\n========== ToolSieve: unknown [#l2a:role] blocks ==========');

// Test 23: Unknown block markers stripped, content preserved
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('[#l2a:question]\nCâu hỏi của tôi\n[/l2a:question]');
  const contentText = events
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(contentText, '\nCâu hỏi của tôi\n', 'Unknown block: markers stripped, inner text preserved');
}

// Test 24: Unknown block with text before and after
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('hello [#l2a:question]\ntest\n[/l2a:question] bye');
  // [#l2a:question] is NOT at line start (comes after "hello ") → passes through as content
  // But [/l2a:question] IS at line start after \n → treated as end, emitting "test"
  // Actually: "hello [#l2a:question]" has no \n before [#l2a so it's all content
  // "\ntest\n" then "[/l2a:question]" is at line start and closes
  // " bye" after [/l2a:question] is content
  const contentText = events
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assert(contentText.includes('hello '), 'Unknown block inline: "hello " in content');
  assert(contentText.includes('test'), 'Unknown block inline: "test" in content');
  assert(contentText.includes(' bye'), 'Unknown block inline: " bye" in content');
}

// Test 25: Unknown block streaming (split across chunks)
{
  const sieve = new ToolSieve();
  // [#l2a:quest is now recognized as a partial [#l2a:...] tag (no closing ']') — held in buffer
  const e1 = sieve.processChunk('text\n[#l2a:quest');
  assert(
    e1.some((e) => e.type === 'content' && e.text === 'text\n'),
    'Streaming unknown: text before partial emitted',
  );
  assert(
    !e1.some((e) => e.type === 'content' && e.text!.includes('[#l2a:quest')),
    'Streaming unknown: partial [#l2a:quest held in buffer',
  );

  const e2 = sieve.processChunk('ion]\ninner content\n[/l2a');
  // [#l2a:question] reconstructed → enters unknown block mode. inner content emitted, [/l2a held as partial.
  const innerContent = e2
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(innerContent, '\ninner content\n', 'Streaming unknown: inner content emitted (tags stripped)');
  assert(
    !e2.some((e) => e.type === 'content' && e.text!.includes('ion]')),
    'Streaming unknown: "ion]" consumed by tag reconstruction',
  );

  const e3 = sieve.processChunk(':question] after');
  // Completes [/l2a:question] → closes unknown block. " after" emitted as content.
  const afterContent = e3
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assertEq(afterContent, ' after', 'Streaming unknown: text after end tag emitted');
}

// Test 26: Unknown block then tool_call (both handled)
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk(
    '[#l2a:question]\nwhat?\n[/l2a:question]\n' +
      '[#l2a:tool_call]\n[#l2a:parameter:id]call_1_test_fn[/l2a:parameter:id]\n[#l2a:parameter:name]test_fn[/l2a:parameter:name]\n[#l2a:parameter:arguments]{"x":1}[/l2a:parameter:arguments]\n[/l2a:tool_call]',
  );
  const contentEvents = events.filter((e) => e.type === 'content');
  const toolStartEvents = events.filter((e) => e.type === 'tool_call_start');
  const fieldNameEvents = events.filter((e) => e.type === 'tool_call_field_delta' && e.field === 'name');
  assert(contentEvents.length >= 1, 'Mixed: has content from unknown block');
  assertEq(toolStartEvents.length, 1, 'Mixed: 1 tool_call_start event');
  const nameText = fieldNameEvents.map((e) => e.text).join('');
  assert(nameText.includes('test_fn'), 'Mixed: tool_call name streamed correctly');
}

// Test 27: Unknown block without closing → emitted as-is on flush
{
  const sieve = new ToolSieve();
  const events = sieve.processChunk('[#l2a:question]\nunclosed content');
  const flushed = sieve.flush();
  const flushedText = flushed
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assert(flushedText.includes('[#l2a:question]'), 'Unclosed unknown: emits opening tag on flush');
  assert(flushedText.includes('unclosed content'), 'Unclosed unknown: emits content on flush');
}

console.log('\n========== ToolSieve: tool_call tag split across chunks ==========');

// Test 28: tool_call start tag split inside role name
{
  const sieve = new ToolSieve();
  // Normal intro text, then tool_call start tag split in the middle
  const e1 = sieve.processChunk('Let me check.\n\n[#l2a:tool_cal');
  // Text before partial should be emitted, partial held
  assert(
    e1.some((e) => e.type === 'content' && e.text === 'Let me check.\n\n'),
    'Split TC: text before partial emitted',
  );
  assertEq(e1.filter((e) => e.type === 'tool_call_start').length, 0, 'Split TC: no tool_call_start yet');

  // Second chunk completes the tag
  const e2 = sieve.processChunk(
    'l]\n[#l2a:parameter:id]\ncall_1_glob\n[/l2a:parameter:id]\n[#l2a:parameter:name]\nglob\n[/l2a:parameter:name]\n[#l2a:parameter:arguments]\n{"pattern":"**"}\n[/l2a:parameter:arguments]\n[/l2a:tool_call]',
  );
  assertEq(e2.filter((e) => e.type === 'tool_call_start').length, 1, 'Split TC: tool_call_start detected');
  const nameDeltas = e2
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'name')
    .map((e) => e.text)
    .join('');
  assertEq(nameDeltas, 'glob', 'Split TC: name field streamed without surrounding newlines');
  const argsDeltas = e2
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'arguments')
    .map((e) => e.text)
    .join('');
  assert(argsDeltas.includes('{"pattern":"**"}'), 'Split TC: arguments field streamed');
  assertEq(e2.filter((e) => e.type === 'tool_call_end').length, 1, 'Split TC: tool_call_end emitted');
}

// Test 29: Real-world example — model response with tool calls split across chunks
{
  const sieve = new ToolSieve();
  const fullResponse =
    'Hãy để tôi kiểm tra cấu trúc dự án và các file cấu hình để xem có test không.\n\n' +
    '[#l2a:tool_call]\n[#l2a:parameter:id]\ncall_1_glob\n[/l2a:parameter:id]\n[#l2a:parameter:name]\nglob\n[/l2a:parameter:name]\n[#l2a:parameter:arguments]\n{"pattern":"**/*.test.{ts,tsx,js,jsx}"}\n[/l2a:parameter:arguments]\n[/l2a:tool_call]\n\n' +
    '[#l2a:tool_call]\n[#l2a:parameter:id]\ncall_2_read\n[/l2a:parameter:id]\n[#l2a:parameter:name]\nread\n[/l2a:parameter:name]\n[#l2a:parameter:arguments]\n{"filePath":"package.json"}\n[/l2a:parameter:arguments]\n[/l2a:tool_call]';

  // Split at a point inside the first tool_call tag name
  const splitPoint = fullResponse.indexOf('[#l2a:tool_call]') + '[#l2a:tool_c'.length;
  const part1 = fullResponse.slice(0, splitPoint);
  const part2 = fullResponse.slice(splitPoint);

  const e1 = sieve.processChunk(part1);
  const e2 = sieve.processChunk(part2);

  // Verify content before tool calls is preserved
  assert(
    e1.some((e) => e.type === 'content' && e.text!.includes('Hãy để tôi kiểm tra')),
    'Real-world: intro text emitted',
  );

  // Verify tool calls detected
  const tcStarts = [
    ...e1.filter((e) => e.type === 'tool_call_start'),
    ...e2.filter((e) => e.type === 'tool_call_start'),
  ];
  assertEq(tcStarts.length, 2, 'Real-world: 2 tool_call_start events');

  const tcEnds = [...e1.filter((e) => e.type === 'tool_call_end'), ...e2.filter((e) => e.type === 'tool_call_end')];
  assertEq(tcEnds.length, 2, 'Real-world: 2 tool_call_end events');

  // Verify field values
  const idDeltas = [...e1, ...e2]
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'id')
    .map((e) => e.text)
    .join('');
  assertEq(idDeltas, 'call_1_globcall_2_read', 'Real-world: call ids streamed without surrounding newlines');

  const nameDeltas = [...e1, ...e2]
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'name')
    .map((e) => e.text)
    .join('');
  assertEq(nameDeltas, 'globread', 'Real-world: tool names streamed without surrounding newlines');
}

// Test 30: Parameter end tag split inside field name
{
  const sieve = new ToolSieve();
  const e1 = sieve.processChunk('[#l2a:tool_call]\n[#l2a:parameter:id]\ncall_1_test\n[/l2a:paramet');
  assertEq(e1.filter((e) => e.type === 'tool_call_start').length, 1, 'Split paramEnd: tool_call_start');
  // [/l2a:paramet is a partial — the content before it (call_1_test\n) is emitted, tag held
  const deltas1 = e1
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'id')
    .map((e) => e.text)
    .join('');
  assert(deltas1.includes('call_1_test'), 'Split paramEnd: id value emitted');
  // Field should NOT be closed yet (partial end tag)
  assertEq(
    e1.filter((e) => e.type === 'tool_call_field_end' && e.field === 'id').length,
    0,
    'Split paramEnd: field not closed yet',
  );

  const e2 = sieve.processChunk('er:id]\n[#l2a:parameter:name]\ntest\n[/l2a:parameter:name]\n[/l2a:tool_call]');
  assertEq(
    e2.filter((e) => e.type === 'tool_call_field_end' && e.field === 'id').length,
    1,
    'Split paramEnd: field closed after completion',
  );
  const nameDeltas = e2
    .filter((e) => e.type === 'tool_call_field_delta' && e.field === 'name')
    .map((e) => e.text)
    .join('');
  assert(nameDeltas.includes('test'), 'Split paramEnd: name field streamed after id closed');
}

// Test 31: Tool call with unknown block before it (split tags)
{
  const sieve = new ToolSieve();
  // Unknown block that's split, followed by tool_call
  const e1 = sieve.processChunk('[#l2a:thin');
  // Partial held
  assert(!e1.some((e) => e.type === 'content' && e.text!.includes('[#l2a:thin')), 'Mixed split: partial held');

  const e2 = sieve.processChunk('king]\nI need to think...\n[/l2a:thinking]\n\n[#l2a:tool_ca');
  // thinking block closed, inner text emitted, tool_call partial held
  assert(
    e2.some((e) => e.type === 'content' && e.text!.includes('I need to think')),
    'Mixed split: thinking content emitted',
  );
  assertEq(e2.filter((e) => e.type === 'tool_call_start').length, 0, 'Mixed split: tool_call not started yet');

  const e3 = sieve.processChunk(
    'll]\n[#l2a:parameter:id]\ncall_1_test\n[/l2a:parameter:id]\n[#l2a:parameter:name]\ntest\n[/l2a:parameter:name]\n[#l2a:parameter:arguments]\n{}\n[/l2a:parameter:arguments]\n[/l2a:tool_call]',
  );
  assertEq(
    e3.filter((e) => e.type === 'tool_call_start').length,
    1,
    'Mixed split: tool_call_start after tag completion',
  );
  assertEq(e3.filter((e) => e.type === 'tool_call_end').length, 1, 'Mixed split: tool_call_end');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
