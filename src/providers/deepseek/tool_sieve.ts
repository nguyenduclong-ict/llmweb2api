import type { ParsedToolCall } from './tool_parser';
import { parseToolCallBlock } from './tool_parser';

export interface SieveEvent {
  type: 'content' | 'tool_calls';
  text?: string;
  toolCalls?: ParsedToolCall[];
}

const MARKER_PREFIX = '[#llmweb2api:';

const START_MARKER = '[#llmweb2api:tool_call]';
const END_MARKER = '[$llmweb2api:tool_call]';

// Generate partial prefixes for tool_call markers
const ALL_MARKERS = [START_MARKER, END_MARKER];
const PARTIALS: string[] = [];
for (const m of ALL_MARKERS) {
  for (let i = 1; i < m.length; i++) {
    PARTIALS.push(m.slice(0, i));
  }
}
const UNIQUE_PARTIALS = [...new Set(PARTIALS)].sort((a, b) => b.length - a.length);

// ── ToolSieve ───────────────────────────────────────────────────────
// Detects [#llmweb2api:tool_call]\n...\n[$llmweb2api:tool_call] blocks.
// Unknown [#llmweb2api:*] blocks (model hallucination) → stripped,
// inner content emitted as regular text.
// Emits one tool_calls event per completed block (supports streaming
// multiple tool calls incrementally).

export class ToolSieve {
  private buffer = '';
  private capturing = false;
  private unknownBlockEnd: string | null = null; // end marker for unknown block

  processChunk(text: string): SieveEvent[] {
    const events: SieveEvent[] = [];
    if (!text) return events;

    this.buffer += text;

    while (true) {
      if (!this.capturing && !this.unknownBlockEnd) {
        // Look for any [#llmweb2api:* marker
        const markerIdx = this.buffer.indexOf(MARKER_PREFIX);
        if (markerIdx < 0) {
          const partial = this.checkAnyPartial();
          if (partial) {
            const content = this.buffer.slice(0, -partial.length);
            this.buffer = partial;
            if (content) events.push({ type: 'content', text: content });
          } else {
            if (this.buffer) events.push({ type: 'content', text: this.buffer });
            this.buffer = '';
          }
          break;
        }

        // Emit text before marker
        if (markerIdx > 0) {
          events.push({ type: 'content', text: this.buffer.slice(0, markerIdx) });
        }

        // Extract block name
        const afterPrefix = this.buffer.slice(markerIdx + MARKER_PREFIX.length);
        const nameEnd = afterPrefix.indexOf(']');
        if (nameEnd < 0) {
          // Partial — keep only marker portion for next chunk
          this.buffer = this.buffer.slice(markerIdx);
          break;
        }
        const blockName = afterPrefix.slice(0, nameEnd);

        if (blockName === 'tool_call') {
          // Known: tool_call block
          this.buffer = afterPrefix.slice(nameEnd + 1);
          this.capturing = true;
          continue;
        }

        // Unknown block: find corresponding end marker
        this.unknownBlockEnd = `[$llmweb2api:${blockName}]`;
        this.buffer = afterPrefix.slice(nameEnd + 1);
        continue;
      }

      // Inside unknown block: find end marker, emit content without markers
      if (this.unknownBlockEnd) {
        const endIdx = this.buffer.indexOf(this.unknownBlockEnd);
        if (endIdx < 0) {
          // Check for partial end marker
          const partial = this.checkPartialEnd(this.unknownBlockEnd);
          if (partial) {
            const innerContent = this.buffer.slice(0, -partial.length);
            this.buffer = partial;
            if (innerContent) events.push({ type: 'content', text: innerContent });
          }
          break;
        }
        // Found end marker → emit inner content, strip both markers
        const inner = this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + this.unknownBlockEnd.length);
        this.unknownBlockEnd = null;
        if (inner) events.push({ type: 'content', text: inner });
        continue;
      }

      // Capturing tool_call: find end marker
      const endIdx = this.buffer.indexOf(END_MARKER);
      if (endIdx < 0) {
        const partial = this.checkEndPartial();
        if (partial) {
          // Keep partial in buffer, it might complete next chunk
        }
        break;
      }

      const body = this.buffer.slice(0, endIdx);
      this.buffer = this.buffer.slice(endIdx + END_MARKER.length);
      this.capturing = false;

      const toolCalls = parseToolCallBlock(body);
      if (toolCalls.length > 0) {
        events.push({ type: 'tool_calls', toolCalls });
      } else if (body.trim()) {
        console.error('[TOOL_SIEVE] Captured tool_call block but failed to parse.');
        console.error('[TOOL_SIEVE] Body:', body);
      }
      continue;
    }

    return events;
  }

  flush(): SieveEvent[] {
    const events: SieveEvent[] = [];

    if (this.capturing) {
      let body = this.buffer;
      const partial = this.checkEndPartial();
      if (partial) {
        body = body.slice(0, -partial.length);
      }

      const toolCalls = parseToolCallBlock(body);
      if (toolCalls.length > 0) {
        events.push({ type: 'tool_calls', toolCalls });
      } else {
        if (body.trim()) {
          console.error('[TOOL_SIEVE] Flush: unclosed tool_call block failed to parse.');
          console.error('[TOOL_SIEVE] Body:', body);
        }
        if (this.buffer) {
          events.push({ type: 'content', text: START_MARKER + this.buffer });
        }
      }
      this.capturing = false;
    } else if (this.unknownBlockEnd) {
      // Unknown block didn't close → emit with markers as-is
      events.push({ type: 'content', text: `${MARKER_PREFIX}${this.unknownBlockEnd.slice('[$llmweb2api:'.length, -1)}]${this.buffer}` });
      this.unknownBlockEnd = null;
    } else if (this.buffer) {
      events.push({ type: 'content', text: this.buffer });
    }

    this.buffer = '';
    return events;
  }

  // Check if buffer ends with a partial of ANY [#llmweb2api: prefix
  private checkAnyPartial(): string | null {
    for (let i = 1; i <= MARKER_PREFIX.length; i++) {
      const p = MARKER_PREFIX.slice(0, i);
      if (this.buffer.endsWith(p)) return p;
    }
    // Also check tool_call partials (for compatibility)
    for (const p of UNIQUE_PARTIALS) {
      if (this.buffer.endsWith(p)) return p;
    }
    return null;
  }

  private checkPartialEnd(marker: string): string | null {
    for (let i = 1; i < marker.length; i++) {
      const p = marker.slice(0, i);
      if (this.buffer.endsWith(p)) return p;
    }
    return null;
  }

  private checkEndPartial(): string | null {
    return this.checkPartialEnd(END_MARKER);
  }
}
