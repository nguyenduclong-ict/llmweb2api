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

  if (debugCtx) {
    console.error(`[TOOL_PARSER] parseCodeToJson failed. ${debugCtx}`);
    console.error(`[TOOL_PARSER] Content (${content.length} chars):`, content.slice(0, 500));
  }
  return null;
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
  let remaining = text;

  while (true) {
    const startIdx = remaining.indexOf(START_MARKER);
    if (startIdx < 0) break;

    const afterStart = remaining.slice(startIdx + START_MARKER.length);
    let endIdx = afterStart.indexOf(END_MARKER);
    const nextStart = afterStart.indexOf(START_MARKER);

    // If a START_MARKER appears before the END_MARKER (or no END_MARKER at all),
    // the END_MARKER belongs to a later block → implicit close at START_MARKER.
    if (nextStart >= 0 && (endIdx < 0 || nextStart < endIdx)) {
      endIdx = nextStart;
    } else if (endIdx < 0) {
      // No END_MARKER and no next START_MARKER → close at end of text
      endIdx = afterStart.length;
    }

    const body = afterStart.slice(0, endIdx);
    const afterBody = afterStart.slice(endIdx);

    // Advance past body + end marker (or stay at next start for next iteration)
    if (afterBody.startsWith(END_MARKER)) {
      remaining = afterBody.slice(END_MARKER.length);
    } else {
      remaining = afterBody;
    }

    const parsed = parseCodeToToolCall(body, `block #${results.length + 1}`);
    if (parsed) {
      results.push(parsed);
    } else if (body.trim()) {
      console.error(`[TOOL_PARSER] Marker block #${results.length + 1} found but failed to parse.`);
      console.error('[TOOL_PARSER] Full body:', body);
      console.error('[TOOL_PARSER] Full input text:', text);
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
