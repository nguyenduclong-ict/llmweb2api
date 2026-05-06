export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function parseToolCallXML(xml: string): ParsedToolCall[] {
  const cleaned = xml.trim();

  const jsonMatch = cleaned.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item: unknown) => item && typeof item === 'object' && (item as Record<string, unknown>).name)
          .map((item: Record<string, unknown>) => ({
            name: item.name as string,
            arguments: (item.arguments as Record<string, unknown>) || {},
          }));
      }
    } catch {
      // fall through to XML parsing
    }
  }

  return parseToolCallXMLFallback(cleaned);
}

function parseToolCallXMLFallback(xml: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];

  let cleaned = xml;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  }

  cleaned = cleaned
    .replace(/<ds:invoke/g, '<invoke')
    .replace(/<\/ds:invoke/g, '</invoke')
    .replace(/<ds:parameter/g, '<parameter')
    .replace(/<\/ds:parameter/g, '</parameter')
    .replace(/<ds:tool_calls/g, '<tool_calls')
    .replace(/<\/ds:tool_calls/g, '</tool_calls');

  const invokeRegex = /<invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/invoke>/g;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRegex.exec(cleaned)) !== null) {
    const name = invokeMatch[1];
    const body = invokeMatch[2];
    const args = parseParameters(body);
    results.push({ name, arguments: args });
  }

  if (results.length === 0) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.name && parsed.arguments) {
          results.push({
            name: parsed.name,
            arguments: parsed.arguments,
          });
        }
      } catch {
        // not JSON
      }
    }
  }

  return results;
}

function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  const paramRegex = /<parameter\s+name="([^"]*)"\s*>([\s\S]*?)<\/parameter>/g;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = paramRegex.exec(body)) !== null) {
    const name = paramMatch[1];
    let value = paramMatch[2].trim();

    const cdataMatch = value.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) {
      value = cdataMatch[1];
    }

    args[name] = coerceValue(value);
  }

  return args;
}

function coerceValue(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '') return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // not valid JSON, return as string
    }
  }

  return trimmed;
}
