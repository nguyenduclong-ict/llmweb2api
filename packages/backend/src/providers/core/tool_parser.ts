import { unwrapBlockContent } from './tool_prompt';

export interface ParsedToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── [#l2a:tool_call] / [#l2a:parameter:X] marker parser ─────────────

const L2A_TC_START = '[#l2a:tool_call]';
const L2A_TC_END = '[/l2a:tool_call]';
const L2A_PARAM_PREFIX = '[#l2a:parameter:';
const OLD_TC_START = '[#llmweb2api:tool_call]';
const OLD_TC_END = '[$llmweb2api:tool_call]';

function parseL2aToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const lines = text.split('\n');

  let depth = 0;
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith(L2A_TC_START)) {
      if (depth > 0) {
        const parsed = parseParameterLines(bodyLines.join('\n'));
        if (parsed) results.push(parsed);
        bodyLines.length = 0;
      }
      depth = 1;
      continue;
    }

    if (line.startsWith(L2A_TC_END) && depth > 0) {
      depth--;
      if (depth === 0) {
        const parsed = parseParameterLines(bodyLines.join('\n'));
        if (parsed) results.push(parsed);
        bodyLines.length = 0;
      }
      continue;
    }

    if (depth > 0) {
      bodyLines.push(line);
    }
  }

  if (depth > 0) {
    const parsed = parseParameterLines(bodyLines.join('\n'));
    if (parsed) results.push(parsed);
  }

  return results;
}

function parseParameterLines(body: string): ParsedToolCall | null {
  const id = extractParamField(body, 'id');
  const name = extractParamField(body, 'name');
  const argsStr = extractParamField(body, 'arguments');

  if (!name) return null;

  let args: Record<string, unknown> = {};
  if (argsStr) {
    try {
      args = JSON.parse(argsStr);
    } catch {
      args = { _raw: argsStr };
      console.error('[TOOL_PARSER] Failed to parse arguments JSON:', argsStr.slice(0, 200));
    }
  }

  const result: ParsedToolCall = { name, arguments: args };
  if (id) result.id = id;
  return result;
}

function extractParamField(body: string, field: string): string | null {
  const startTag = `[#l2a:parameter:${field}]`;
  const endTag = `[/l2a:parameter:${field}]`;

  const startIdx = body.indexOf(startTag);
  if (startIdx < 0) return null;

  const contentStart = startIdx + startTag.length;
  const endIdx = body.indexOf(endTag, contentStart);

  if (endIdx < 0) {
    const after = body.slice(contentStart);
    const nextParamIdx = after.indexOf(L2A_PARAM_PREFIX);
    if (nextParamIdx >= 0) {
      return unwrapBlockContent(after.slice(0, nextParamIdx)) || null;
    }
    return unwrapBlockContent(after) || null;
  }

  return unwrapBlockContent(body.slice(contentStart, endIdx)) || null;
}

// ── Main parser ────────────────────────────────────────────────────

export function parseToolCallXML(xml: string): ParsedToolCall[] {
  const cleaned = xml.trim();

  // New [#l2a:tool_call] format
  const l2aResults = parseL2aToolCalls(cleaned);
  if (l2aResults.length > 0) return l2aResults;

  // Fallback: old [#llmweb2api:tool_call] format
  const oldResults = parseOldMarkerFormat(cleaned);
  if (oldResults.length > 0) return oldResults;

  return [];
}

export function parseToolCallBlock(body: string): ParsedToolCall[] {
  // Try new [#l2a:parameter:X] sub-field format
  const parsed = parseParameterLines(body);
  if (parsed) return [parsed];

  // Fallback: old JSON format
  return parseOldJsonBlocks(body);
}

// ── Old format fallbacks ────────────────────────────────────────────

function parseOldMarkerFormat(text: string): ParsedToolCall[] {
  const oldStart = text.indexOf(OLD_TC_START);
  if (oldStart < 0) return [];

  const results: ParsedToolCall[] = [];
  const lines = text.split('\n');
  let depth = 0;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(OLD_TC_START)) {
      if (depth > 0) {
        const body = bodyLines.join('\n');
        bodyLines.length = 0;
        const parsed = parseOldJsonBody(body);
        if (parsed) results.push(parsed);
      }
      depth = 1;
      continue;
    }
    if (line.startsWith(OLD_TC_END)) {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          const body = bodyLines.join('\n');
          bodyLines.length = 0;
          const parsed = parseOldJsonBody(body);
          if (parsed) results.push(parsed);
        }
      }
      continue;
    }
    if (depth > 0) bodyLines.push(line);
  }

  if (depth > 0) {
    const parsed = parseOldJsonBody(bodyLines.join('\n'));
    if (parsed) results.push(parsed);
  }

  return results;
}

function parseOldJsonBody(body: string): ParsedToolCall | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const obj = parseCodeToJson(trimmed);
  if (obj) return objToToolCall(obj);

  return null;
}

function parseOldJsonBlocks(body: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  let i = 0;

  while (i < body.length) {
    while (i < body.length) {
      if (body[i] === '{') {
        const prev = i === 0 ? '\n' : body[i - 1];
        const after = body[i + 1];
        if ((prev === '\n' || prev === '\r' || i === 0) && after === '"') break;
      }
      i++;
    }
    if (i >= body.length) break;

    const start = i;
    let depth = 0;

    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          i++;
          const obj = parseCodeToJson(body.slice(start, i));
          if (obj) {
            const tc = objToToolCall(obj);
            if (tc) results.push(tc);
          }
          break;
        }
      }
    }

    if (depth > 0 && i >= body.length) {
      const obj = parseCodeToJson(body.slice(start));
      if (obj) {
        const tc = objToToolCall(obj);
        if (tc) results.push(tc);
      }
      break;
    }
  }

  return results;
}

// ── JSON helpers (shared with old format) ────────────────────────────

function parseCodeToJson(content: string): Record<string, unknown> | null {
  let c = content.trim();
  if (!c) return null;

  if (c.startsWith('```')) {
    const nl = c.indexOf('\n');
    if (nl < 0) return null;
    c = c.slice(nl + 1);
    const fenceIdx = c.lastIndexOf('\n```');
    if (fenceIdx >= 0) {
      const after = c.slice(fenceIdx + 4);
      if (after === '' || after.startsWith('\n') || after.startsWith('\r')) {
        c = c.slice(0, fenceIdx).trimEnd();
      }
    }
  }

  if (!c) return null;

  try {
    const obj = JSON.parse(c);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* fall through */
  }

  return null;
}

function objToToolCall(obj: Record<string, unknown>): ParsedToolCall | null {
  if (obj.name && typeof obj.name === 'string') {
    const result: ParsedToolCall = {
      name: obj.name,
      arguments: (obj.arguments as Record<string, unknown>) || {},
    };
    if (obj.id && typeof obj.id === 'string') result.id = obj.id;
    return result;
  }

  // Model error: {"tool_name": {...}}
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
    return { name: keys[0], arguments: obj[keys[0]] as Record<string, unknown> };
  }

  return null;
}
