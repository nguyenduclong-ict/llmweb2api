export type SieveEventType =
  | 'content'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'tool_call_field_start'
  | 'tool_call_field_delta'
  | 'tool_call_field_end';

export interface SieveEvent {
  type: SieveEventType;
  text?: string;
  field?: string;
}

const TC_START = '[#l2a:tool_call]';
const TC_END = '[/l2a:tool_call]';
const PARAM_PREFIX = '[#l2a:parameter:';
const PARAM_END_PREFIX = '[/l2a:parameter:';
const TAG_PREFIX = '[#l2a:';
const TAG_END_PREFIX = '[/l2a:';

// All possible partial prefixes of [#l2a:... and [/l2a:...
function buildPartials(): string[] {
  const prefixes = [TAG_PREFIX, TAG_END_PREFIX];
  const partials: string[] = [];
  for (const p of prefixes) {
    for (let i = 1; i <= p.length; i++) {
      partials.push(p.slice(0, i));
    }
  }
  // Also include plain [ and [/ for robustness
  partials.push('[', '[/');
  return [...new Set(partials)].sort((a, b) => b.length - a.length);
}

const PARTIALS = buildPartials();

export class ToolSieve {
  private buffer = '';
  private capturing = false;
  private currentField: string | null = null;
  private unknownBlockRole: string | null = null;
  private toolCallIndex = 0;

  processChunk(text: string): SieveEvent[] {
    const events: SieveEvent[] = [];
    if (!text) return events;

    this.buffer += text;

    while (true) {
      if (!this.capturing && !this.unknownBlockRole) {
        // ── Idle: look for [#l2a: at line start ──────────────────
        const tcIdx = this.findAtLineStart(TC_START);
        const otherIdx = this.findOtherMarkerAtLineStart();

        const tagIdx = this.closest(tcIdx, otherIdx);
        if (tagIdx < 0) {
          const partial = this.checkPartialAtLineEnd();
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

        // Emit text before tag
        if (tagIdx > 0) {
          events.push({ type: 'content', text: this.buffer.slice(0, tagIdx) });
        }

        // Which tag did we find?
        if (tagIdx === tcIdx) {
          // [#l2a:tool_call]
          this.buffer = this.buffer.slice(tagIdx + TC_START.length);
          this.capturing = true;
          this.currentField = null;
          this.toolCallIndex++;
          events.push({ type: 'tool_call_start' });
          continue;
        }

        // Some other [#l2a:ROLE] — unknown block
        const afterPrefix = this.buffer.slice(tagIdx + TAG_PREFIX.length);
        const endBracket = afterPrefix.indexOf(']');
        if (endBracket < 0) {
          // Partial — keep
          this.buffer = this.buffer.slice(tagIdx);
          break;
        }
        const role = afterPrefix.slice(0, endBracket);
        this.unknownBlockRole = role;
        this.buffer = afterPrefix.slice(endBracket + 1);
        continue;
      }

      // ── Inside unknown block: find [/l2a:ROLE] at line start ──────
      if (this.unknownBlockRole) {
        const endMarker = `[/l2a:${this.unknownBlockRole}]`;
        const endIdx = this.findAtLineStart(endMarker);
        if (endIdx < 0) {
          const partial = this.checkPartialAtLineEnd();
          if (partial) {
            const inner = this.buffer.slice(0, -partial.length);
            this.buffer = partial;
            if (inner) events.push({ type: 'content', text: inner });
          }
          break;
        }
        const inner = this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + endMarker.length);
        this.unknownBlockRole = null;
        if (inner) events.push({ type: 'content', text: inner });
        continue;
      }

      // ── Inside tool_call: look for parameter, parameter end, or [/l2a:tool_call] ──
      const endIdx = this.findAtLineStart(TC_END);
      const paramIdx = this.findParamAtLineStart();
      const paramEndIdx = this.findParamEnd(); // no line-start req — end tags can be inline

      if (endIdx < 0 && paramIdx < 0 && paramEndIdx < 0) {
        const partial = this.checkPartialAtLineEnd();
        if (partial) {
          const content = this.buffer.slice(0, -partial.length);
          this.buffer = partial;
          if (content) this.emitFieldDelta(events, content);
        } else {
          if (this.buffer) {
            this.emitFieldDelta(events, this.buffer);
            this.buffer = '';
          }
        }
        break;
      }

      // Pick the earliest marker
      const candidates: Array<{ idx: number; kind: 'end' | 'param' | 'paramEnd' }> = [];
      if (endIdx >= 0) candidates.push({ idx: endIdx, kind: 'end' });
      if (paramIdx >= 0) candidates.push({ idx: paramIdx, kind: 'param' });
      if (paramEndIdx >= 0) candidates.push({ idx: paramEndIdx, kind: 'paramEnd' });
      candidates.sort((a, b) => a.idx - b.idx);
      const first = candidates[0];

      if (first.kind === 'end') {
        // [/l2a:tool_call] — end tool_call or close current parameter
        if (endIdx > 0) {
          this.emitFieldDelta(events, this.buffer.slice(0, endIdx));
        }
        if (this.currentField) {
          events.push({ type: 'tool_call_field_end', field: this.currentField });
          this.currentField = null;
          this.buffer = this.buffer.slice(endIdx + TC_END.length);
          continue;
        }
        // No field open → end tool_call
        this.buffer = this.buffer.slice(endIdx + TC_END.length);
        this.capturing = false;
        events.push({ type: 'tool_call_end' });
        continue;
      }

      if (first.kind === 'paramEnd') {
        // [/l2a:parameter:X] — verify tag is complete (has closing ']')
        const afterPrefix = this.buffer.slice(paramEndIdx + PARAM_END_PREFIX.length);
        const closingBracket = afterPrefix.indexOf(']');
        if (closingBracket < 0) {
          // Partial tag — hold in buffer, wait for next chunk
          if (paramEndIdx > 0) {
            this.emitFieldDelta(events, this.buffer.slice(0, paramEndIdx));
          }
          this.buffer = this.buffer.slice(paramEndIdx);
          break;
        }
        // Complete tag — close current parameter
        if (paramEndIdx > 0) {
          this.emitFieldDelta(events, this.buffer.slice(0, paramEndIdx));
        }
        if (this.currentField) {
          events.push({ type: 'tool_call_field_end', field: this.currentField });
          this.currentField = null;
        }
        this.buffer = afterPrefix.slice(closingBracket + 1);
        continue;
      }

      // Parameter found: [#l2a:parameter:X]
      const afterParam = this.buffer.slice(paramIdx + PARAM_PREFIX.length);
      const endBracketIdx = afterParam.indexOf(']');
      if (endBracketIdx < 0) {
        // Partial parameter — keep
        const partial = this.buffer.slice(paramIdx);
        const content = this.buffer.slice(0, paramIdx);
        this.buffer = partial;
        if (content) this.emitFieldDelta(events, content);
        break;
      }

      const field = afterParam.slice(0, endBracketIdx);

      // Emit content before this parameter
      if (paramIdx > 0) {
        this.emitFieldDelta(events, this.buffer.slice(0, paramIdx));
      }

      // Close previous field
      if (this.currentField) {
        events.push({ type: 'tool_call_field_end', field: this.currentField });
      }

      // Start new field
      this.currentField = field;
      this.buffer = afterParam.slice(endBracketIdx + 1);
      events.push({ type: 'tool_call_field_start', field });
      continue;
    }

    return events;
  }

  flush(): SieveEvent[] {
    const events: SieveEvent[] = [];

    if (this.capturing) {
      if (this.buffer) {
        const partial = this.checkPartialAtLineEnd();
        if (partial) {
          const content = this.buffer.slice(0, -partial.length);
          if (content) this.emitFieldDelta(events, content);
        } else {
          this.emitFieldDelta(events, this.buffer);
        }
      }
      if (this.currentField) {
        events.push({ type: 'tool_call_field_end', field: this.currentField });
        this.currentField = null;
      }
      events.push({ type: 'tool_call_end' });
      this.capturing = false;
    } else if (this.unknownBlockRole) {
      const roleTag = `[#l2a:${this.unknownBlockRole}]`;
      events.push({ type: 'content', text: roleTag + this.buffer });
      this.unknownBlockRole = null;
    } else if (this.buffer) {
      events.push({ type: 'content', text: this.buffer });
    }

    this.buffer = '';
    return events;
  }

  reset() {
    this.buffer = '';
    this.capturing = false;
    this.currentField = null;
    this.unknownBlockRole = null;
  }

  // ── Private helpers ────────────────────────────────────────────

  private findAtLineStart(tag: string): number {
    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const idx = this.buffer.indexOf(tag, searchFrom);
      if (idx < 0) return -1;
      if (idx === 0 || this.buffer[idx - 1] === '\n') return idx;
      searchFrom = idx + 1;
    }
    return -1;
  }

  // Find [#l2a:ROLE] (not tool_call) at line start
  private findOtherMarkerAtLineStart(): number {
    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const idx = this.buffer.indexOf(TAG_PREFIX, searchFrom);
      if (idx < 0) return -1;
      if (idx !== 0 && this.buffer[idx - 1] !== '\n') {
        searchFrom = idx + 1;
        continue;
      }
      // Check it's not [#l2a:tool_call]
      if (this.buffer.startsWith(TC_START, idx)) {
        searchFrom = idx + 1;
        continue;
      }
      // Must have a valid role (ends with ])
      const after = this.buffer.slice(idx + TAG_PREFIX.length);
      const endBracket = after.indexOf(']');
      if (endBracket < 0) {
        // Partial — could be tool_call or other, treat as partial
        searchFrom = idx + 1;
        continue;
      }
      return idx;
    }
    return -1;
  }

  // Find [/l2a:parameter:X] — no line-start req, end tags can be inline
  private findParamEnd(): number {
    return this.buffer.indexOf(PARAM_END_PREFIX);
  }

  // Find [#l2a:parameter:X] at line start
  private findParamAtLineStart(): number {
    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const idx = this.buffer.indexOf(PARAM_PREFIX, searchFrom);
      if (idx < 0) return -1;
      if (idx !== 0 && this.buffer[idx - 1] !== '\n') {
        searchFrom = idx + 1;
        continue;
      }
      return idx;
    }
    return -1;
  }

  private closest(a: number, b: number): number {
    if (a < 0 && b < 0) return -1;
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  private emitFieldDelta(events: SieveEvent[], text: string) {
    if (!text) return;
    const field = this.currentField || 'unknown';
    const normalizedText = field === 'id' || field === 'name' ? text.trim() : text;
    if (!normalizedText) return;
    events.push({ type: 'tool_call_field_delta', field, text: normalizedText });
  }

  private checkPartialAtLineEnd(): string | null {
    // Known fixed prefixes from TAG_PREFIX and TAG_END_PREFIX
    for (const p of PARTIALS) {
      if (this.buffer.endsWith(p)) {
        const partialStart = this.buffer.length - p.length;
        if (partialStart === 0 || this.buffer[partialStart - 1] === '\n') {
          return p;
        }
      }
    }

    // Detect partial [#l2a:...] tag where chunk boundary falls inside the role name
    // e.g. buffer ends with "[#l2a:tool_cal" — no closing ']' yet
    const lastOpen = this.buffer.lastIndexOf(TAG_PREFIX);
    if (lastOpen >= 0 && (lastOpen === 0 || this.buffer[lastOpen - 1] === '\n')) {
      const after = this.buffer.slice(lastOpen + TAG_PREFIX.length);
      if (after.length > 0 && !after.includes(']')) {
        return this.buffer.slice(lastOpen);
      }
    }

    // Detect partial [/l2a:...] tag
    // e.g. buffer ends with "[/l2a:parameter:i" — no closing ']' yet
    const lastEnd = this.buffer.lastIndexOf(TAG_END_PREFIX);
    if (lastEnd >= 0 && (lastEnd === 0 || this.buffer[lastEnd - 1] === '\n')) {
      const after = this.buffer.slice(lastEnd + TAG_END_PREFIX.length);
      if (after.length > 0 && !after.includes(']')) {
        return this.buffer.slice(lastEnd);
      }
    }

    return null;
  }
}
