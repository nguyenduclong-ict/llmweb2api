import crypto from 'crypto';
import type { InternalMessage } from '../../types/common';

export interface MessageHashEntry {
  parent_message_id: number | null;
  request_message_id: number;
  image_summary?: string;
  image_count?: number;
}

export type HashCacheMap = Record<string, MessageHashEntry>;

const TRACKED_ROLES = new Set(['user', 'tool']);

export function hashMessage(msg: InternalMessage): string {
  const normalized = msg.role + ':' + hashableContent(msg);
  return crypto.createHash('md5').update(normalized).digest('hex');
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

/**
 * Cập nhật parent_message_id cho tất cả tracked messages trong request
 * sau khi có assistant response. Đảm bảo entry lưu đúng assistant response ID
 * thay vì null (khi tạo entry lần đầu chưa có response).
 */
export function updateHashCacheParentId(
  hashCache: HashCacheMap,
  requestMessages: InternalMessage[],
  lastResponseMessageId: number,
): void {
  const tracked = filterTrackedMessages(requestMessages);
  for (const msg of tracked) {
    const h = hashMessage(msg);
    if (hashCache[h]) {
      hashCache[h].parent_message_id = lastResponseMessageId;
    }
  }
}
