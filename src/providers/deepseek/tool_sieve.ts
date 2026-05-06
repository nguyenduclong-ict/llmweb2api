export interface SieveEvent {
  type: 'content' | 'tool_calls';
  text?: string;
  xml?: string;
}

const OPEN_TAG = '<tool_calls>';

// Partial tag patterns that might appear at the end of a chunk
const PARTIAL_PATTERNS: string[] = [];
for (let i = 1; i < OPEN_TAG.length; i++) {
  PARTIAL_PATTERNS.push(OPEN_TAG.slice(0, i));
}
// Also support legacy <ds:tool_calls> format
for (let i = 1; i < '<ds:tool_calls>'.length; i++) {
  PARTIAL_PATTERNS.push('<ds:tool_calls>'.slice(0, i));
}

const OPEN_TAG_REGEX = /<(?:ds:tool_calls|tool_calls)>/;
const CLOSE_TAG_REGEX = /<\/(?:ds:tool_calls|tool_calls)>/;

export class ToolSieve {
  private buffer = '';
  private capturing = false;
  private captureStart = 0;

  processChunk(text: string): SieveEvent[] {
    const events: SieveEvent[] = [];
    if (!text) return events;

    this.buffer += text;

    while (true) {
      if (!this.capturing) {
        const match = OPEN_TAG_REGEX.exec(this.buffer);
        if (!match) {
          // Check for partial tag at end
          const partial = this.checkPartial();
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

        // Emit text before the tag
        if (match.index > 0) {
          events.push({ type: 'content', text: this.buffer.slice(0, match.index) });
        }

        this.capturing = true;
        this.captureStart = match.index;
        console.log('[SIEVE] detected open tag at index', match.index, 'buffer head:', this.buffer.slice(match.index, match.index + 50));
        continue;
      }

      // Capturing mode: look for close tag
      const closeMatch = CLOSE_TAG_REGEX.exec(this.buffer);
      if (!closeMatch) {
        // Check for partial close tag
        const partialClose = this.checkPartialClose();
        if (partialClose) break;
        break;
      }

      // Found close tag
      const xmlEnd = closeMatch.index + closeMatch[0].length;
      const xml = this.buffer.slice(this.captureStart, xmlEnd);
      console.log('[SIEVE] tool_calls captured, xml length:', xml.length);

      events.push({ type: 'tool_calls', xml });

      this.buffer = this.buffer.slice(xmlEnd);
      this.capturing = false;
      this.captureStart = 0;
    }

    return events;
  }

  flush(): SieveEvent[] {
    const events: SieveEvent[] = [];

    if (this.capturing) {
      console.log('[SIEVE] flush while capturing, buffer head:', this.buffer.slice(0, 100));
      const closeMatch = CLOSE_TAG_REGEX.exec(this.buffer);
      if (closeMatch) {
        const xmlEnd = closeMatch.index + closeMatch[0].length;
        const xml = this.buffer.slice(this.captureStart, xmlEnd);
        console.log('[SIEVE] flush found close tag, emitting tool_calls');
        events.push({ type: 'tool_calls', xml });
        this.buffer = this.buffer.slice(xmlEnd);
      } else {
        if (this.buffer) {
          console.log('[SIEVE] flush no close tag, emitting as content');
          events.push({ type: 'content', text: this.buffer });
        }
      }
      this.capturing = false;
    } else if (this.buffer) {
      console.log('[SIEVE] flush normal, buffer head:', this.buffer.slice(0, 100));
      events.push({ type: 'content', text: this.buffer });
    }

    this.buffer = '';
    return events;
  }

  private checkPartial(): string | null {
    for (let i = PARTIAL_PATTERNS.length - 1; i >= 0; i--) {
      const p = PARTIAL_PATTERNS[i];
      if (this.buffer.endsWith(p)) {
        return p;
      }
    }
    return null;
  }

  private checkPartialClose(): boolean {
    // Check partial close tags: </ds:tool_calls> and </tool_calls>
    const tags = ['</ds:tool_calls>', '</tool_calls>'];
    for (const tag of tags) {
      for (let i = 1; i < tag.length; i++) {
        if (this.buffer.endsWith(tag.slice(0, i))) return true;
      }
    }
    return false;
  }
}
