// Run: npx tsx tests/parse_tool_calls.test.ts
import { parseToolCallBlock, parseToolCallXML } from '../providers/core/tool_parser';

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

// â”€â”€ Test cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n=== 1. YAML format with ```yaml fence ===');
const r1 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: test_fn
arguments:
  key: value
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r1.length, 1, '1 tool call');
assertEq(r1[0].name, 'test_fn', 'name');
assertEq(r1[0].arguments, { key: 'value' }, 'arguments');

console.log('\n=== 2. YAML multi-line string with | ===');
const r2 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: edit
arguments:
  filePath: C:\\Users\\ADMIN\\Desktop\\file.tsx
  oldString: |
    import { useState } from "react";
    import { Button } from "../components/ui/button";
    const x = \${template};
  newString: |
    import { useState } from "react";
    import { apiPost } from "../api/client";
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r2.length, 1, '1 tool call');
assertEq(r2[0].name, 'edit', 'name');
const a2 = r2[0].arguments;
assert(typeof a2.filePath === 'string', 'filePath present');
assert(typeof a2.oldString === 'string', 'oldString present');
assert(typeof a2.newString === 'string', 'newString present');
if (typeof a2.oldString === 'string') {
  assert(a2.oldString.includes('import { useState }'), 'oldString: has react import');
  assert(a2.oldString.includes('"react"'), 'oldString: preserves quotes in code');
  assert(a2.oldString.includes('${template}'), 'oldString: preserves template literal');
}

console.log('\n=== 3. Multiple YAML blocks ===');
const r3 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn1
arguments:
  a: 1
\`\`\`
[$llmweb2api:tool_call]
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn2
arguments:
  b: 2
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r3.length, 2, '2 tool calls');
assertEq(r3[0].name, 'fn1', 'first name');
assertEq(r3[1].name, 'fn2', 'second name');

console.log('\n=== 4. JSON format still works (backwards compat) ===');
const r4 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`json
{"name": "json_fn", "arguments": {"key": "value"}}
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r4.length, 1, '1 tool call from JSON');
assertEq(r4[0].name, 'json_fn', 'name from JSON');

console.log('\n=== 5. Bare JSON without fence (backwards compat) ===');
const r5 = parseToolCallXML(`
[#llmweb2api:tool_call]
{"name": "bare_fn", "arguments": {"x": 1}}
[$llmweb2api:tool_call]
`);
assertEq(r5.length, 1, '1 tool call from bare JSON');
assertEq(r5[0].name, 'bare_fn', 'name from bare JSON');

console.log('\n=== 6. Old [#llmweb2api:tool_calls] multi-call format ===');
const r6 = parseToolCallXML(`
[#llmweb2api:tool_calls]
{"name": "old1", "arguments": {"x": 1}}
{"name": "old2", "arguments": {"y": 2}}
[$llmweb2api:tool_calls]
`);
assertEq(r6.length, 2, '2 tool calls from old format');
assertEq(r6[0].name, 'old1', 'first old name');
assertEq(r6[1].name, 'old2', 'second old name');

console.log('\n=== 7. Single-key fallback {"tool_name": {...}} ===');
const r7 = parseToolCallXML(`
[#llmweb2api:tool_call]
{"task": {"description": "Find file logic", "subagent_type": "explore"}}
[$llmweb2api:tool_call]
`);
assertEq(r7.length, 1, '1 tool call via single-key fallback');
assertEq(r7[0].name, 'task', 'name from single key');

console.log('\n=== 8. YAML without fence (bare) ===');
const r8 = parseToolCallXML(`
[#llmweb2api:tool_call]
name: no_fence_fn
arguments:
  key: val
[$llmweb2api:tool_call]
`);
assertEq(r8.length, 1, '1 tool call from bare YAML');
assertEq(r8[0].name, 'no_fence_fn', 'name from bare YAML');

console.log('\n=== 9. parseToolCallBlock with YAML ===');
const r9 = parseToolCallBlock(`
\`\`\`yaml
name: block_fn
arguments:
  x: 1
\`\`\`
`);
assertEq(r9.length, 1, '1 tool call from block YAML');
assertEq(r9[0].name, 'block_fn', 'name from block');

console.log('\n=== 10. Empty fence â†’ no results ===');
const r10 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r10.length, 0, '0 tool calls for empty fence');

console.log('\n=== 11. Invalid YAML in fence â†’ no results ===');
const r11 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
: invalid yaml :
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r11.length, 0, '0 tool calls for invalid YAML');

console.log('\n=== 12. Garbage text â†’ no results ===');
const r12 = parseToolCallXML('not yaml at all just some text');
assertEq(r12.length, 0, '0 tool calls for garbage');

console.log('\n=== 13. Empty body ===');
const r13 = parseToolCallXML('');
assertEq(r13.length, 0, '0 tool calls for empty');

console.log('\n=== 14. Windows path in YAML ===');
const r14 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: edit
arguments:
  filePath: C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\pages\\Login.tsx
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r14.length, 1, '1 tool call');
assertEq(
  r14[0].arguments.filePath,
  'C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\pages\\Login.tsx',
  'windows path',
);

console.log('\n=== 15. YAML with complex nested arguments ===');
const r15 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: complex_fn
arguments:
  arr:
    - 1
    - 2
    - nested: yes
  obj:
    deep:
      deeper:
        - 3
        - 4
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r15.length, 1, '1 tool call');
assertEq(r15[0].arguments.arr, [1, 2, { nested: 'yes' }], 'nested array');
assertEq(r15[0].arguments.obj, { deep: { deeper: [3, 4] } }, 'nested object');

console.log('\n=== 16. Fence without language tag (bare ```) ===');
const r16 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`
name: bare_fence_fn
arguments:
  key: val
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r16.length, 1, '1 tool call from bare fence');
assertEq(r16[0].name, 'bare_fence_fn', 'name from bare fence');

console.log('\n=== 17. JSON inside bare ``` fence ===');
const r17 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`
{"name": "json_bare_fence", "arguments": {"x": 1}}
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r17.length, 1, '1 tool call from JSON in bare fence');
assertEq(r17[0].name, 'json_bare_fence', 'name from JSON in bare fence');

console.log('\n=== 18. Missing closing marker â†’ implicit close at next block ===');
const r18 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn1
arguments:
  x: 1
\`\`\`
text outside block
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn2
arguments:
  y: 2
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r18.length, 2, '2 tool calls via implicit close');
assertEq(r18[0].name, 'fn1', 'first via implicit close');
assertEq(r18[1].name, 'fn2', 'second closes normally');

console.log('\n=== 19. All blocks missing closing markers ===');
const r19 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn_a
arguments:
  a: 1
\`\`\`
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn_b
arguments:
  b: 2
\`\`\`
[#llmweb2api:tool_call]
\`\`\`yaml
name: fn_c
arguments:
  c: 3
\`\`\`
`);
assertEq(r19.length, 3, '3 tool calls all implicit close');
assertEq(r19[0].name, 'fn_a', 'first implicit');
assertEq(r19[1].name, 'fn_b', 'second implicit');
assertEq(r19[2].name, 'fn_c', 'third implicit (end of text)');

console.log('\n=== 20. Real DeepSeek multi-tool-call pattern ===');
const r20 = parseToolCallXML(`
[#llmweb2api:tool_call]

name: glob
arguments:
  pattern: "**/*.tsx"
  path: C:\\Users\\Desktop\\Code

[#llmweb2api:tool_call]

name: grep
arguments:
  pattern: "adapter"
  path: C:\\Users\\Desktop\\Code
`);
assertEq(r20.length, 2, '2 tools from real pattern');
assertEq(r20[0].name, 'glob', 'first tool name');
assertEq(r20[1].name, 'grep', 'second tool name');

console.log('\n=== 21. Block with trailing garbage (model hallucinated text) ===');
const r21 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: read_fn
arguments:
  filePath: test.ts
\`\`\`
some model text that shouldn't be here
[$llmweb2api:tool_call]
`);
assertEq(r21.length, 1, '1 tool call despite trailing text in body');
assertEq(r21[0].name, 'read_fn', 'parsed correctly despite trailing garbage');

console.log('\n=== 22. YAML with unindented continuation line ===');
const r22 = parseToolCallXML(`
[#llmweb2api:tool_call]

name: edit
arguments:
  filePath: C:\\Users\\ADMIN\\Desktop\\Code\\test.ts
  oldString: import { statsRoutes } from './routes/stats';
  newString: import { statsRoutes } from './routes/stats';
import { analyticsRoutes } from './routes/analytics';

[$llmweb2api:tool_call]
`);
assertEq(r22.length, 1, '1 tool call despite unindented continuation');
assertEq(r22[0].name, 'edit', 'name: edit');
assertEq(r22[0].arguments.filePath, 'C:\\Users\\ADMIN\\Desktop\\Code\\test.ts', 'filePath preserved');
const ns = r22[0].arguments.newString as string;
assert(ns.includes('analyticsRoutes'), 'newString: contains analyticsRoutes');
assert(ns.includes('statsRoutes'), 'newString: contains statsRoutes');

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  console.log('\n=== 23. Bare YAML with double-quoted Windows path (model output format) ===');
  const r23 = parseToolCallXML("\n[#llmweb2api:tool_call]\n\nname: read\narguments:\n  filePath: \"C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\components\\charts\\TokenUsageChart.tsx\"\n\n[$llmweb2api:tool_call]\n");
  assertEq(r23.length, 1, '1 tool call from double-quoted Windows path');
  assertEq(r23[0].name, 'read', 'name: read');
  assertEq(r23[0].arguments.filePath, 'C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\components\\charts\\TokenUsageChart.tsx', 'double-quoted windows path preserved');

  console.log('\n=== 24. Multiple bare YAML blocks with double-quoted Windows paths ===');
  const r24 = parseToolCallXML("\n[#llmweb2api:tool_call]\n\nname: read\narguments:\n  filePath: \"C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\components\\charts\\TokenUsageChart.tsx\"\n\n[#llmweb2api:tool_call]\n\nname: read\narguments:\n  filePath: \"C:\\Users\\ADMIN\\Desktop\\Code\\chat2api\\llmweb2api\\ui\\src\\components\\charts\\RouteTrafficChart.tsx\"\n\n[$llmweb2api:tool_call]\n");
  assertEq(r24.length, 2, '2 tool calls from multi bare YAML');
  assertEq(r24[0].name, 'read', 'first name');
  assertEq(r24[1].name, 'read', 'second name');
  assert(typeof r24[0].arguments.filePath === 'string', 'first filePath is string');
  assert(typeof r24[1].arguments.filePath === 'string', 'second filePath is string');

  console.log('\n=== 25. Block markers inside old_string/new_string values (YAML | scalar) ===');
  const r25 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: edit
arguments:
  filePath: test.ts
  old_string: |
    [#llmweb2api:system]
    hello world
    [$llmweb2api:system]
  new_string: |
    [#llmweb2api:system]
    new hello world
    [$llmweb2api:system]
\`\`\`
[$llmweb2api:tool_call]
`);
  assertEq(r25.length, 1, '1 tool call despite markers inside values');
  assertEq(r25[0].name, 'edit', 'name: edit');
  const a25 = r25[0].arguments;
  assert(typeof a25.old_string === 'string', 'old_string is string');
  assert(typeof a25.new_string === 'string', 'new_string is string');
  if (typeof a25.old_string === 'string') {
    assert(a25.old_string.includes('[#llmweb2api:system]'), 'old_string preserves [#llmweb2api:system]');
    assert(a25.old_string.includes('[$llmweb2api:system]'), 'old_string preserves [$llmweb2api:system]');
  }

  console.log('\n=== 26. Nested tool_call markers inside values should not disrupt parsing ===');
  const r26 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`yaml
name: edit
arguments:
  old_string: |
    [#llmweb2api:tool_call]
    some_code();
    [$llmweb2api:tool_call]
  new_string: |
    [#llmweb2api:tool_call]
    new_code();
    [$llmweb2api:tool_call]
\`\`\`
[$llmweb2api:tool_call]
`);
  assertEq(r26.length, 1, '1 tool call despite nested markers in values');
  assertEq(r26[0].name, 'edit', 'name: edit despite nested markers');

if (failed > 0) process.exit(1);

