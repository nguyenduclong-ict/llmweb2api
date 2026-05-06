import type { InternalMessage } from '../../types/common';
import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';

export interface ConversationRecord {
  conversation_id: string;
  account_id: number | null;
  provider: string;
  messages: string;
  created_at: string;
  updated_at: string;
}

export function getByConversationId(conversationId: string): ConversationRecord | undefined {
  return prepareAndGet<ConversationRecord>('SELECT * FROM conversations WHERE conversation_id = ?', [conversationId]);
}

export function saveConversation(
  conversationId: string,
  accountId: number,
  providerName: string,
  messages: InternalMessage[],
): void {
  const json = JSON.stringify(messages);
  const existing = getByConversationId(conversationId);
  if (existing) {
    prepareAndRun(
      "UPDATE conversations SET account_id = ?, provider = ?, messages = ?, updated_at = datetime('now') WHERE conversation_id = ?",
      [accountId, providerName, json, conversationId],
    );
  } else {
    prepareAndRun('INSERT INTO conversations (conversation_id, account_id, provider, messages) VALUES (?, ?, ?, ?)', [
      conversationId,
      accountId,
      providerName,
      json,
    ]);
  }
}

export function loadMessages(conversationId: string): InternalMessage[] | undefined {
  const row = getByConversationId(conversationId);
  if (!row) return undefined;
  try {
    return JSON.parse(row.messages) as InternalMessage[];
  } catch {
    return undefined;
  }
}

export function removeConversation(conversationId: string): void {
  prepareAndRun('DELETE FROM conversations WHERE conversation_id = ?', [conversationId]);
}

export function pruneOldConversations(maxAgeHours: number): number {
  const rows = prepareAndAll<{ count: number }>(
    `SELECT COUNT(*) as count FROM conversations WHERE updated_at < datetime('now', '-${maxAgeHours} hours')`,
  );
  const count = rows[0]?.count ?? 0;
  if (count > 0) {
    prepareAndRun(`DELETE FROM conversations WHERE updated_at < datetime('now', '-${maxAgeHours} hours')`);
  }
  return count;
}
