import type { InternalMessage } from '../../types/common';

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function filterValidTools(tools: ToolDef[]): ToolDef[] {
  return tools.filter((t) => t?.type === 'function' && t?.function?.name);
}

export function buildToolPrompt(tools: ToolDef[]): string {
  const valid = filterValidTools(tools);
  const toolsJson = JSON.stringify(valid);

  return `<tools>
${toolsJson}
</tools>

When you need to call tools, output a JSON array inside <tool_calls>:

<tool_calls>
[{"name": "TOOL_NAME", "arguments": {"param1": "value1"}}]
</tool_calls>

For multiple tools:
<tool_calls>
[{"name": "tool1", "arguments": {...}}, {"name": "tool2", "arguments": {...}}]
</tool_calls>

Rules:
1. Output ONLY the <tool_calls> block — no extra text before or after
2. The content inside <tool_calls> must be a valid JSON array
3. Each item has "name" (string) and "arguments" (object)`;
}

export function injectToolPrompt(messages: InternalMessage[], tools: ToolDef[]): InternalMessage[] {
  const toolPrompt = buildToolPrompt(tools);
  const result = [...messages];

  const sysIdx = result.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    const sysMsg = result[sysIdx];
    const existing = typeof sysMsg.content === 'string' ? sysMsg.content : '';
    result[sysIdx] = { ...sysMsg, content: existing + '\n\n' + toolPrompt };
  } else {
    result.unshift({ role: 'system', content: toolPrompt });
  }

  return result;
}
