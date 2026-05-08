import { parse as yamlParse } from 'yaml';

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const START_MARKER = '[#llmweb2api:tool_call]';
const END_MARKER = '[$llmweb2api:tool_call]';

// ── Code-to-JSON helper ─────────────────────────────────────────────
// Auto-detects format: fenced (```, ```yaml, ```json) or bare, then
// tries JSON.parse first, falls back to YAML.

function parseCodeToJson(body: string, debugCtx?: string): Record<string, unknown> | null {
  let content = body.trim();
  if (!content) return null;

  // Strip leading ``` fence (with or without language tag)
  if (content.startsWith('```')) {
    const nl = content.indexOf('\n');
    if (nl < 0) return null;
    content = content.slice(nl + 1);
    // Strip trailing ``` — find the last ``` on its own line
    // (may be followed by garbage text from model hallucination)
    const fenceIdx = content.lastIndexOf('\n```');
    if (fenceIdx >= 0) {
      const after = content.slice(fenceIdx + 4);
      // Accept ``` alone, or ``` followed by newline + garbage
      if (after === '' || after.startsWith('\n') || after.startsWith('\r')) {
        content = content.slice(0, fenceIdx).trimEnd();
      }
    }
  }

  if (!content) return null;

  // Try JSON first (stricter, faster)
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    // fall through to YAML
  }

  // Try YAML (superset of JSON)
  try {
    const obj = yamlParse(content, { strict: false });
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    // fall through
  }

  // Fix backslash escaping (e.g. Windows paths in double-quoted strings)
  const backslashFixed = fixYamlBackslashes(content);
  if (backslashFixed !== content) {
    try {
      const obj = yamlParse(backslashFixed, { strict: false });
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {
      // fall through
    }
  }

  // Fallback: fix unindented continuation lines — model sometimes outputs
  // multi-line values without YAML | literal scalar, breaking indentation.
  const fixed = fixYamlContinuations(content);
  if (fixed !== content) {
    try {
      const obj = yamlParse(fixed, { strict: false });
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {
      // fall through
    }
  }

  if (debugCtx) {
    console.error(`[TOOL_PARSER] parseCodeToJson failed. ${debugCtx}`);
    console.error(`[TOOL_PARSER] Content (${content.length} chars):`, content.slice(0, 500));
  }
  return null;
}

// Fix unescaped backslashes inside YAML double-quoted strings.
// Windows paths like "C:\Users\..." contain \U, \A, etc. which are
// invalid YAML escape sequences and cause parse failures.
function fixYamlBackslashes(yaml: string): string {
  // Only applies to double-quoted strings where \ is an escape char.
  // Unquoted scalars treat \ literally and don't need fixing.
  if (!yaml.includes('"')) return yaml;

  const validSimple = new Set(['\\', '"', 'n', 'r', 'b', 't', 'f', '/', ' ']);
  let result = '';
  let inDQ = false;
  for (let i = 0; i < yaml.length; i++) {
    const ch = yaml[i];
    if (!inDQ) {
      result += ch;
      if (ch === '"') inDQ = true;
      continue;
    }
    if (ch === '\\') {
      const next = yaml[i + 1];
      if (!next) { result += '\\\\'; continue; }
      if (validSimple.has(next)) { result += '\\' + next; i++; continue; }
      if (next === 'x' && /^[0-9a-fA-F]{2}/.test(yaml.slice(i + 2, i + 4))) { result += yaml.slice(i, i + 4); i += 3; continue; }
      if (next === 'u' && /^[0-9a-fA-F]{4}/.test(yaml.slice(i + 2, i + 6))) { result += yaml.slice(i, i + 6); i += 5; continue; }
      if (next === 'U' && /^[0-9a-fA-F]{8}/.test(yaml.slice(i + 2, i + 10))) { result += yaml.slice(i, i + 10); i += 9; continue; }
      // Invalid escape (e.g. \U without 8 hex digits) → literal backslash
      result += '\\\\';
      continue;
    }
    if (ch === '"') { inDQ = false; }
    result += ch;
  }
  return result;
}

// Fix lines that break YAML indentation: when a line at column 0 follows
// an indented block, it's likely a continuation of the previous value.
function fixYamlContinuations(yaml: string): string {
  const lines = yaml.split('\n');
  const out: string[] = [];
  let needFix = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(trimmed);
      continue;
    }

    const indent = trimmed.length - trimmed.trimStart().length;
    const hasColon = /:\s/.test(trimmed) || trimmed.endsWith(':');

    // Line at column 0, not a key:value, preceded by indented content → continuation
    if (i > 0 && indent === 0 && !hasColon) {
      const prevOut = out[out.length - 1];
      const prevIndent = prevOut.length - prevOut.trimStart().length;
      const fixIndent = prevIndent + 2;
      out.push(' '.repeat(fixIndent) + trimmed);
      needFix = true;
    } else {
      out.push(trimmed);
    }
  }

  return needFix ? out.join('\n') : yaml;
}

function parseCodeToToolCall(body: string, debugCtx?: string): ParsedToolCall | null {
  const obj = parseCodeToJson(body, debugCtx);
  if (!obj) return null;

  // Standard: {name, arguments}
  if (obj.name && typeof obj.name === 'string') {
    return {
      name: obj.name,
      arguments: (obj.arguments as Record<string, unknown>) || {},
    };
  }

  // Model error: {"tool_name": {...}} — single key = name, value = arguments
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
    return {
      name: keys[0],
      arguments: obj[keys[0]] as Record<string, unknown>,
    };
  }

  if (debugCtx) {
    console.error(`[TOOL_PARSER] parseCodeToToolCall: JSON/YAML OK but unexpected structure. ${debugCtx}`);
    console.error('[TOOL_PARSER] Parsed keys:', keys);
    console.error('[TOOL_PARSER] Parsed object:', JSON.stringify(obj).slice(0, 500));
  }
  return null;
}

// ── Main parser ────────────────────────────────────────────────────

export function parseToolCallXML(xml: string): ParsedToolCall[] {
  const cleaned = xml.trim();

  // Find all [#llmweb2api:tool_call]...[$llmweb2api:tool_call] blocks
  const results = extractMarkerBlocks(cleaned);
  if (results.length > 0) return results;

  // Fallback: old [#llmweb2api:tool_calls]...[$llmweb2api:tool_calls] (multi-call block)
  const oldStart = cleaned.indexOf('[#llmweb2api:tool_calls]');
  if (oldStart >= 0) {
    const afterStart = cleaned.slice(oldStart + '[#llmweb2api:tool_calls]'.length);
    const oldEnd = afterStart.indexOf('[$llmweb2api:tool_calls]');
    const body = oldEnd >= 0 ? afterStart.slice(0, oldEnd) : afterStart;
    const oldResults = parseToolCallBlock(body);
    if (oldResults.length > 0) return oldResults;
  }

  return [];
}

export function parseToolCallBlock(body: string): ParsedToolCall[] {
  const parsed = parseCodeToToolCall(body);
  if (parsed) return [parsed];

  // Fallback: depth-track { } blocks for JSON array of objects
  return parseJsonBlocks(body);
}

// ── Internal ────────────────────────────────────────────────────────

function extractMarkerBlocks(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const lines = text.split('\n');

  // Scan line-by-line: only markers at line-start (column 0) count.
  // Markers inside YAML literal blocks (indented) are ignored.
  let depth = 0;
  let blockStartLine = -1;
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith(START_MARKER)) {
      if (depth > 0) {
        // Implicit close: new START before END → flush current block
        const body = bodyLines.join('\n');
        bodyLines.length = 0;
        const parsed = parseCodeToToolCall(body, `block #${results.length + 1}`);
        if (parsed) {
          results.push(parsed);
        } else if (body.trim()) {
          console.error(`[TOOL_PARSER] Marker block #${results.length + 1} implicit close, parse failed.`);
          console.error('[TOOL_PARSER] Full body:', body.slice(0, 500));
        }
        depth = 0;
      }
      depth = 1;
      blockStartLine = i;
      continue;
    }

    if (line.startsWith(END_MARKER)) {
      if (depth > 0) {
        depth--;
        if (depth === 0 && blockStartLine >= 0) {
          const body = bodyLines.join('\n');
          bodyLines.length = 0;
          const parsed = parseCodeToToolCall(body, `block #${results.length + 1}`);
          if (parsed) {
            results.push(parsed);
          } else if (body.trim()) {
            console.error(`[TOOL_PARSER] Marker block #${results.length + 1} found but failed to parse.`);
            console.error('[TOOL_PARSER] Full body:', body.slice(0, 500));
          }
        }
      }
      continue;
    }

    if (depth > 0) {
      bodyLines.push(line);
    }
  }

  // Flush remaining block at end of text (no closing marker)
  if (depth > 0) {
    const body = bodyLines.join('\n');
    const parsed = parseCodeToToolCall(body, `block #${results.length + 1}`);
    if (parsed) {
      results.push(parsed);
    } else if (body.trim()) {
      console.error(`[TOOL_PARSER] Marker block #${results.length + 1} unclosed, parse failed.`);
      console.error('[TOOL_PARSER] Full body:', body.slice(0, 500));
    }
  }

  return results;
}

// Depth-track JSON objects (fallback for old multi-object format).
// Only matches { at line-start (or string-start) followed by " to avoid
// false positives on code braces like `import { foo }` or `${x}`.
function parseJsonBlocks(body: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  let i = 0;

  while (i < body.length) {
    // Find next { that looks like a JSON object start
    while (i < body.length) {
      if (body[i] === '{') {
        // Must be at start of string or after newline, followed by "
        const prev = i === 0 ? '\n' : body[i - 1];
        const after = body[i + 1];
        if ((prev === '\n' || prev === '\r' || i === 0) && after === '"') {
          break;
        }
      }
      i++;
    }
    if (i >= body.length) break;

    const start = i;
    let depth = 0;

    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          i++;
          const obj = parseCodeToJson(body.slice(start, i));
          if (obj) {
            const keys = Object.keys(obj);
            if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
              results.push({ name: keys[0], arguments: obj[keys[0]] as Record<string, unknown> });
            } else if (obj.name && typeof obj.name === 'string') {
              results.push({
                name: obj.name,
                arguments: (obj.arguments as Record<string, unknown>) || {},
              });
            }
          }
          break;
        }
      }
    }

    if (depth > 0 && i >= body.length) {
      const obj = parseCodeToJson(body.slice(start));
      if (obj) {
        const keys = Object.keys(obj);
        if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
          results.push({ name: keys[0], arguments: obj[keys[0]] as Record<string, unknown> });
        } else if (obj.name && typeof obj.name === 'string') {
          results.push({
            name: obj.name,
            arguments: (obj.arguments as Record<string, unknown>) || {},
          });
        }
      }
      break;
    }
  }

  return results;
}
