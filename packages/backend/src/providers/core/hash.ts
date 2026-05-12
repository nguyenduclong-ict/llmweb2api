import crypto from 'crypto';
import type { InternalMessage } from '../../types/common';

const TRACKED_ROLES = new Set(['system', 'user', 'tool']);

export function hashMessage(msg: InternalMessage): string {
  const normalized = msg.role + ':' + hashableContent(msg);
  return crypto.createHash('md5').update(normalized).digest('hex');
}

export function hashMessages(messages: InternalMessage[]): string {
  if (messages.length === 0) return '';
  return crypto.createHash('md5').update(messages.map(hashMessage).join('|')).digest('hex');
}

function hashableContent(msg: InternalMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (msg.role === 'user') {
    return msg.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }
  return JSON.stringify(msg.content);
}

export function filterTrackedMessages(messages: InternalMessage[]): InternalMessage[] {
  return messages.filter((m) => TRACKED_ROLES.has(m.role));
}

export function hashTools(tools: unknown[] | undefined): string | null {
  if (!tools || tools.length === 0) return null;
  return crypto.createHash('md5').update(JSON.stringify(tools)).digest('hex');
}
