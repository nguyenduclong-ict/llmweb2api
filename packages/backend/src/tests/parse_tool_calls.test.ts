// Run: npx tsx tests/parse_tool_calls.test.ts
import { parseToolCallBlock, parseToolCallXML } from '../providers/core/tool_parser';
import { getBlockContent } from '../providers/core/tool_prompt';

let passed = 0;
let failed = 0;

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

// ── New [#l2a:tool_call] marker format tests ───────────────────────────

console.log('\n=== 1. Basic [#l2a:tool_call] marker format ===');
const r1 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]
call_1_test_fn
[/l2a:parameter:id]
[#l2a:parameter:name]
test_fn
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{"key":"value"}
[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r1.length, 1, '1 tool call');
assertEq(r1[0].name, 'test_fn', 'name');
assertEq(r1[0].id, 'call_1_test_fn', 'id');
assertEq(r1[0].arguments, { key: 'value' }, 'arguments');

console.log('\n=== 2. Multiple [#l2a:tool_call] blocks ===');
const r2 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_read[/l2a:parameter:id]
[#l2a:parameter:name]read[/l2a:parameter:name]
[#l2a:parameter:arguments]{"filePath":"test.ts"}[/l2a:parameter:arguments]
[/l2a:tool_call]

[#l2a:tool_call]
[#l2a:parameter:id]call_2_write[/l2a:parameter:id]
[#l2a:parameter:name]write[/l2a:parameter:name]
[#l2a:parameter:arguments]{"filePath":"out.ts","content":"hello"}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r2.length, 2, '2 tool calls');
assertEq(r2[0].name, 'read', 'first name');
assertEq(r2[0].id, 'call_1_read', 'first id');
assertEq(r2[1].name, 'write', 'second name');
assertEq(r2[1].id, 'call_2_write', 'second id');

console.log('\n=== 3. Marker with complex nested JSON arguments ===');
const r3 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_complex_fn[/l2a:parameter:id]
[#l2a:parameter:name]complex_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"arr":[1,2,{"nested":"yes"}],"obj":{"deep":{"deeper":[3,4]}}}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r3.length, 1, '1 tool call');
assertEq(r3[0].arguments.arr, [1, 2, { nested: 'yes' }], 'nested array');
assertEq(r3[0].arguments.obj, { deep: { deeper: [3, 4] } }, 'nested object');

console.log('\n=== 4. Tool call without id parameter ===');
const r4 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:name]no_id_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"x":1}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r4.length, 1, '1 tool call without id');
assertEq(r4[0].name, 'no_id_fn', 'name');
assertEq(r4[0].id, undefined, 'id is undefined');

console.log('\n=== 5. Without name parameter → no result ===');
const r5 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_x[/l2a:parameter:id]
[#l2a:parameter:arguments]{"x":1}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r5.length, 0, '0 tool calls (name required)');

console.log('\n=== 6. Implicit close: new [#l2a:tool_call] before close ===');
const r6 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_a[/l2a:parameter:id]
[#l2a:parameter:name]fn_a[/l2a:parameter:name]
[#l2a:parameter:arguments]{"a":1}[/l2a:parameter:arguments]
[#l2a:tool_call]
[#l2a:parameter:id]call_2_b[/l2a:parameter:id]
[#l2a:parameter:name]fn_b[/l2a:parameter:name]
[#l2a:parameter:arguments]{"b":2}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r6.length, 2, '2 tool calls via implicit close');
assertEq(r6[0].name, 'fn_a', 'first via implicit close');
assertEq(r6[1].name, 'fn_b', 'second closes normally');

console.log('\n=== 7. Unclosed tool_call at end of text ===');
const r7 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_last[/l2a:parameter:id]
[#l2a:parameter:name]last_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"z":99}[/l2a:parameter:arguments]
`);
assertEq(r7.length, 1, '1 tool call from unclosed block');
assertEq(r7[0].name, 'last_fn', 'name from unclosed block');

console.log('\n=== 8. Empty body ===');
const r8 = parseToolCallXML('');
assertEq(r8.length, 0, '0 tool calls for empty');

console.log('\n=== 9. Garbage text → no results ===');
const r9 = parseToolCallXML('just some random text without any tags');
assertEq(r9.length, 0, '0 tool calls for garbage');

console.log('\n=== 10. Arguments with Windows paths ===');
const r10 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_edit[/l2a:parameter:id]
[#l2a:parameter:name]edit[/l2a:parameter:name]
[#l2a:parameter:arguments]{"filePath":"C:\\\\Users\\\\ADMIN\\\\Desktop\\\\file.tsx","oldString":"hello","newString":"world"}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r10.length, 1, '1 tool call');
assertEq(r10[0].arguments.filePath, 'C:\\Users\\ADMIN\\Desktop\\file.tsx', 'windows path');

console.log('\n=== 11. Invalid JSON in arguments → _raw fallback ===');
const r11 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_bad[/l2a:parameter:id]
[#l2a:parameter:name]bad_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{not valid json}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r11.length, 1, '1 tool call despite bad JSON');
assertEq(r11[0].name, 'bad_fn', 'name parsed');
assertEq((r11[0].arguments as any)._raw, '{not valid json}', '_raw fallback');

console.log('\n=== 12. Tool call with text before block ===');
const r12 = parseToolCallXML(`
Some text before
[#l2a:tool_call]
[#l2a:parameter:id]call_1_prefix[/l2a:parameter:id]
[#l2a:parameter:name]prefix_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"x":1}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r12.length, 1, '1 tool call with text before');
assertEq(r12[0].name, 'prefix_fn', 'name despite text before');

console.log('\n=== 13. Empty arguments → {} ===');
const r13 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_empty[/l2a:parameter:id]
[#l2a:parameter:name]empty_args_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r13.length, 1, '1 tool call with empty args');
assertEq(r13[0].arguments, {}, 'empty arguments');

// ── Backward compatibility: old [#llmweb2api:tool_call] format ──────

console.log('\n=== 14. Backwards compat: JSON format with fence ===');
const r14 = parseToolCallXML(`
[#llmweb2api:tool_call]
\`\`\`json
{"name": "json_fn", "arguments": {"key": "value"}}
\`\`\`
[$llmweb2api:tool_call]
`);
assertEq(r14.length, 1, '1 tool call from old JSON format');
assertEq(r14[0].name, 'json_fn', 'name from JSON');

console.log('\n=== 15. Backwards compat: bare JSON ===');
const r15 = parseToolCallXML(`
[#llmweb2api:tool_call]
{"name": "bare_fn", "arguments": {"x": 1}}
[$llmweb2api:tool_call]
`);
assertEq(r15.length, 1, '1 tool call from bare JSON');
assertEq(r15[0].name, 'bare_fn', 'name from bare JSON');

console.log('\n=== 16. Backwards compat: single-key fallback ===');
const r16 = parseToolCallXML(`
[#llmweb2api:tool_call]
{"task": {"description": "Find file logic", "subagent_type": "explore"}}
[$llmweb2api:tool_call]
`);
assertEq(r16.length, 1, '1 tool call via single-key fallback');
assertEq(r16[0].name, 'task', 'name from single key');

console.log('\n=== 17. Old format: properly closed JSON blocks ===');
const r17 = parseToolCallXML(`
[#llmweb2api:tool_call]
{"name": "fn1", "arguments": {"x": 1}}
[$llmweb2api:tool_call]
[#llmweb2api:tool_call]
{"name": "fn2", "arguments": {"y": 2}}
[$llmweb2api:tool_call]
`);
assertEq(r17.length, 2, '2 tool calls properly closed');
assertEq(r17[0].name, 'fn1', 'first name');
assertEq(r17[1].name, 'fn2', 'second name');

console.log('\n=== 18. New [#l2a:tool_call] format takes priority ===');
const r18 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_new[/l2a:parameter:id]
[#l2a:parameter:name]new_format_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"z":999}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r18.length, 1, '1 tool call from new format');
assertEq(r18[0].name, 'new_format_fn', 'new format used');

console.log('\n=== 19. parseToolCallBlock with [#l2a:parameter:] sub-fields ===');
const r19 = parseToolCallBlock(`
[#l2a:parameter:id]call_1_block[/l2a:parameter:id]
[#l2a:parameter:name]block_fn[/l2a:parameter:name]
[#l2a:parameter:arguments]{"x":1}[/l2a:parameter:arguments]
`);
assertEq(r19.length, 1, '1 tool call from block');
assertEq(r19[0].name, 'block_fn', 'name from block');

console.log('\n=== 20. parseToolCallBlock with old JSON (fallback) ===');
const r20 = parseToolCallBlock(`
\`\`\`json
{"name": "block_json_fn", "arguments": {"x": 1}}
\`\`\`
`);
assertEq(r20.length, 1, '1 tool call from block JSON fallback');
assertEq(r20[0].name, 'block_json_fn', 'name from block JSON');

console.log('\n=== 21. Empty [#l2a:tool_call] block → no results ===');
const r21 = parseToolCallXML(`
[#l2a:tool_call]
[/l2a:tool_call]
`);
assertEq(r21.length, 0, '0 tool calls for empty tool_call block');

console.log('\n=== 22. New separate-lines format (content on own line) ===');
const r22a = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]
call_1_edit
[/l2a:parameter:id]
[#l2a:parameter:name]
edit
[/l2a:parameter:name]
[#l2a:parameter:arguments]
{"filePath":"C:\\\\test.ts","oldString":"a","newString":"b"}
[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r22a.length, 1, 'separate-lines: 1 tool call');
assertEq(r22a[0].name, 'edit', 'separate-lines: name');
assertEq(r22a[0].id, 'call_1_edit', 'separate-lines: id');
assertEq(r22a[0].arguments.filePath, 'C:\\test.ts', 'separate-lines: windows path');

console.log('\n=== 23. Real streamed multi-tool-call pattern ===');
const r23 = parseToolCallXML(`
[#l2a:tool_call]
[#l2a:parameter:id]call_1_glob[/l2a:parameter:id]
[#l2a:parameter:name]glob[/l2a:parameter:name]
[#l2a:parameter:arguments]{"pattern":"**/*.tsx","path":"C:\\\\Users\\\\Desktop\\\\Code"}[/l2a:parameter:arguments]
[/l2a:tool_call]

[#l2a:tool_call]
[#l2a:parameter:id]call_2_grep[/l2a:parameter:id]
[#l2a:parameter:name]grep[/l2a:parameter:name]
[#l2a:parameter:arguments]{"pattern":"adapter","path":"C:\\\\Users\\\\Desktop\\\\Code"}[/l2a:parameter:arguments]
[/l2a:tool_call]
`);
assertEq(r23.length, 2, '2 tools from real pattern');
assertEq(r23[0].name, 'glob', 'first tool name');
assertEq(r23[1].name, 'grep', 'second tool name');

console.log('\n=== 24. Block content newline unwrapping ===');
assertEq(getBlockContent('user', '[#l2a:user]hello[/l2a:user]'), 'hello', 'inline block content');
assertEq(getBlockContent('user', '[#l2a:user]\nhello\n[/l2a:user]'), 'hello', 'single layout newline is removed');
assertEq(
  getBlockContent('user', '[#l2a:user]\n\nhello\n[/l2a:user]'),
  '\nhello',
  'intentional blank line after opening marker is preserved',
);

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) process.exit(1);
