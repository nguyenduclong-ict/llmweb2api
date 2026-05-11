import type { InternalMessage } from '../../types/common';
import type { HashCacheMap } from '../../providers/core/hash';
import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';

export interface ConversationRecord {
  conversation_id: string;
  account_id: number | null;
  provider: string;
  messages: string;
  input_tokens: number;
  output_tokens: number;
  tools_hash: string | null;
  last_used: string;
  last_message_id: string | null;
  prompt_cache_key: string | null;
  created_at: string;
  updated_at: string;
}

export function getByConversationId(conversationId: string): ConversationRecord | undefined {
  return prepareAndGet<ConversationRecord>('SELECT * FROM conversations WHERE conversation_id = ?', [conversationId]);
}

export function getByPromptCacheKey(promptCacheKey: string): ConversationRecord | undefined {
  if (!promptCacheKey) return undefined;
  return prepareAndGet<ConversationRecord>(
    'SELECT * FROM conversations WHERE prompt_cache_key = ? ORDER BY last_used DESC LIMIT 1',
    [promptCacheKey],
  );
}

export function updatePromptCacheKey(conversationId: string, promptCacheKey: string): void {
  if (!promptCacheKey || !conversationId) return;
  prepareAndRun(
    `INSERT INTO conversations (conversation_id, prompt_cache_key, messages, provider, input_tokens, output_tokens, last_used)
     VALUES (?, ?, '[]', '', 0, 0, datetime('now','localtime'))
     ON CONFLICT(conversation_id) DO UPDATE SET prompt_cache_key = excluded.prompt_cache_key, last_used = datetime('now','localtime')`,
    [conversationId, promptCacheKey],
  );
}

export function saveConversation(
  conversationId: string,
  accountId: number,
  providerName: string,
  messages: InternalMessage[],
  inputTokens?: number,
  outputTokens?: number,
): void {
  const json = JSON.stringify(messages);
  const existing = getByConversationId(conversationId);
  if (existing) {
    const inTok = inputTokens ?? existing.input_tokens;
    const outTok = outputTokens ?? existing.output_tokens;
    prepareAndRun(
      "UPDATE conversations SET account_id = ?, provider = ?, messages = ?, input_tokens = ?, output_tokens = ?, updated_at = datetime('now'), last_used = datetime('now','localtime') WHERE conversation_id = ?",
      [accountId, providerName, json, inTok, outTok, conversationId],
    );
  } else {
    prepareAndRun(
      "INSERT INTO conversations (conversation_id, account_id, provider, messages, input_tokens, output_tokens, last_used) VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
      [conversationId, accountId, providerName, json, inputTokens ?? 0, outputTokens ?? 0],
    );
  }
}

export function loadTokenStats(conversationId: string): { inputTokens: number; outputTokens: number } | undefined {
  const row = getByConversationId(conversationId);
  if (!row) return undefined;
  return { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 };
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

export function saveHashCache(
  conversationId: string,
  accountId: number,
  providerName: string,
  hashCache: HashCacheMap,
  toolsHash: string | null,
  lastMessageId: string | null,
  inputTokens?: number,
  outputTokens?: number,
): void {
  const json = JSON.stringify(hashCache);
  const existing = getByConversationId(conversationId);
  if (existing) {
    const inTok = inputTokens ?? existing.input_tokens;
    const outTok = outputTokens ?? existing.output_tokens;
    const lastMsgId = lastMessageId ?? existing.last_message_id;
    prepareAndRun(
      "UPDATE conversations SET account_id = ?, provider = ?, messages = ?, input_tokens = ?, output_tokens = ?, tools_hash = ?, last_message_id = ?, updated_at = datetime('now'), last_used = datetime('now','localtime') WHERE conversation_id = ?",
      [accountId, providerName, json, inTok, outTok, toolsHash ?? '', lastMsgId, conversationId],
    );
  } else {
    prepareAndRun(
      "INSERT INTO conversations (conversation_id, account_id, provider, messages, input_tokens, output_tokens, tools_hash, last_message_id, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
      [
        conversationId,
        accountId,
        providerName,
        json,
        inputTokens ?? 0,
        outputTokens ?? 0,
        toolsHash ?? '',
        lastMessageId,
      ],
    );
  }
}

export function loadHashCache(conversationId: string): HashCacheMap | null {
  const row = getByConversationId(conversationId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) return null; // legacy format
    return parsed as HashCacheMap;
  } catch {
    return null;
  }
}

export function loadToolsHash(conversationId: string): string | null {
  const row = getByConversationId(conversationId);
  if (!row) return null;
  return row.tools_hash || null;
}

export function loadLastMessageId(conversationId: string): string | null {
  const row = getByConversationId(conversationId);
  if (!row) return null;
  return row.last_message_id ?? null;
}

export function removeConversation(conversationId: string): void {
  prepareAndRun('DELETE FROM conversations WHERE conversation_id = ?', [conversationId]);
}

export function pruneOldConversations(maxAgeHours: number): number {
  const rows = prepareAndAll<{ count: number }>(
    `SELECT COUNT(*) as count FROM conversations WHERE last_used < datetime('now', '-${maxAgeHours} hours')`,
  );
  const count = rows[0]?.count ?? 0;
  if (count > 0) {
    prepareAndRun(`DELETE FROM conversations WHERE last_used < datetime('now', '-${maxAgeHours} hours')`);
  }
  return count;
}
