import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';

export interface ConversationRecord {
  id?: number;
  conversation_id: string;
  seq: number;
  account_id: number | null;
  provider: string;
  metadata: string;
  messages: string;
  tracked_count: number;
  tracked_hash: string;
  input_tokens: number;
  output_tokens: number;
  tools_hash: string | null;
  last_used: string;
  last_message_id: string | null;
  prompt_cache_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationSessionSummary {
  conversation_id: string;
  seq: number;
  account_id: number | null;
  account_name: string | null;
  provider: string;
  metadata: string;
  tracked_count: number;
  tracked_hash: string;
  tools_hash: string | null;
  last_message_id: string | null;
  prompt_cache_key: string | null;
  last_used: string;
  created_at: string;
  updated_at: string;
  seq_count: number;
}

export interface ConversationStateInput {
  conversationId: string;
  seq: number;
  accountId: number;
  providerName: string;
  metadata: Record<string, unknown>;
  trackedCount: number;
  trackedHash: string;
  toolsHash: string | null;
  lastMessageId: string | null;
  inputTokens?: number;
  outputTokens?: number;
  promptCacheKey?: string;
}

export function getByConversationId(conversationId: string): ConversationRecord | undefined {
  return getLatestByConversationId(conversationId);
}

export function getLatestByConversationId(conversationId: string): ConversationRecord | undefined {
  return prepareAndGet<ConversationRecord>(
    'SELECT * FROM conversations WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1',
    [conversationId],
  );
}

export function listByConversationId(conversationId: string): ConversationRecord[] {
  return prepareAndAll<ConversationRecord>('SELECT * FROM conversations WHERE conversation_id = ? ORDER BY seq DESC', [
    conversationId,
  ]);
}

export function listSessions(): ConversationSessionSummary[] {
  return prepareAndAll<ConversationSessionSummary>(
    `
    SELECT
      c.conversation_id,
      c.seq,
      c.account_id,
      a.name AS account_name,
      c.provider,
      c.metadata,
      c.tracked_count,
      c.tracked_hash,
      c.tools_hash,
      c.last_message_id,
      c.prompt_cache_key,
      c.last_used,
      c.created_at,
      c.updated_at,
      (
        SELECT COUNT(*)
        FROM conversations cx
        WHERE cx.conversation_id = c.conversation_id
      ) AS seq_count
    FROM conversations c
    LEFT JOIN accounts a ON a.id = c.account_id
    INNER JOIN (
      SELECT conversation_id, MAX(seq) AS max_seq
      FROM conversations
      GROUP BY conversation_id
    ) latest
      ON latest.conversation_id = c.conversation_id
     AND latest.max_seq = c.seq
    ORDER BY c.last_used DESC, c.updated_at DESC
    `,
  );
}

export function getByPromptCacheKey(promptCacheKey: string): ConversationRecord | undefined {
  if (!promptCacheKey) return undefined;
  return prepareAndGet<ConversationRecord>(
    'SELECT * FROM conversations WHERE prompt_cache_key = ? ORDER BY last_used DESC, seq DESC LIMIT 1',
    [promptCacheKey],
  );
}

export function updatePromptCacheKey(conversationId: string, promptCacheKey: string): void {
  if (!promptCacheKey || !conversationId) return;
  const existing = getLatestByConversationId(conversationId);
  if (existing) {
    prepareAndRun(
      "UPDATE conversations SET prompt_cache_key = ?, last_used = datetime('now','localtime'), updated_at = datetime('now') WHERE conversation_id = ? AND seq = ?",
      [promptCacheKey, conversationId, existing.seq],
    );
    return;
  }

  prepareAndRun(
    `INSERT INTO conversations (
      conversation_id, seq, provider, metadata, messages, tracked_count, tracked_hash,
      input_tokens, output_tokens, prompt_cache_key, last_used
    ) VALUES (?, 0, '', '{}', '[]', 0, '', 0, 0, ?, datetime('now','localtime'))`,
    [conversationId, promptCacheKey],
  );
}

export function saveConversationState(input: ConversationStateInput): void {
  const existing = prepareAndGet<ConversationRecord>(
    'SELECT * FROM conversations WHERE conversation_id = ? AND seq = ?',
    [input.conversationId, input.seq],
  );

  const inTok = input.inputTokens ?? existing?.input_tokens ?? 0;
  const outTok = input.outputTokens ?? existing?.output_tokens ?? 0;
  const promptCacheKey = input.promptCacheKey ?? existing?.prompt_cache_key ?? '';

  if (existing) {
    prepareAndRun(
      `UPDATE conversations SET
        account_id = ?, provider = ?, metadata = ?, messages = ?, tracked_count = ?,
        tracked_hash = ?, input_tokens = ?, output_tokens = ?, tools_hash = ?, last_message_id = ?,
        prompt_cache_key = ?, updated_at = datetime('now'), last_used = datetime('now','localtime')
       WHERE conversation_id = ? AND seq = ?`,
      [
        input.accountId,
        input.providerName,
        JSON.stringify(input.metadata),
        JSON.stringify({ trackedCount: input.trackedCount, trackedHash: input.trackedHash }),
        input.trackedCount,
        input.trackedHash,
        inTok,
        outTok,
        input.toolsHash ?? '',
        input.lastMessageId,
        promptCacheKey,
        input.conversationId,
        input.seq,
      ],
    );
    return;
  }

  prepareAndRun(
    `INSERT INTO conversations (
      conversation_id, seq, account_id, provider, metadata, messages, tracked_count,
      tracked_hash, input_tokens, output_tokens, tools_hash, last_message_id, prompt_cache_key, last_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [
      input.conversationId,
      input.seq,
      input.accountId,
      input.providerName,
      JSON.stringify(input.metadata),
      JSON.stringify({ trackedCount: input.trackedCount, trackedHash: input.trackedHash }),
      input.trackedCount,
      input.trackedHash,
      inTok,
      outTok,
      input.toolsHash ?? '',
      input.lastMessageId,
      promptCacheKey,
    ],
  );
}

export function loadTokenStats(conversationId: string): { inputTokens: number; outputTokens: number } | undefined {
  const row = getLatestByConversationId(conversationId);
  if (!row) return undefined;
  return { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 };
}

export function loadToolsHash(conversationId: string): string | null {
  const row = getLatestByConversationId(conversationId);
  if (!row) return null;
  return row.tools_hash || null;
}

export function loadLastMessageId(conversationId: string): string | null {
  const row = getLatestByConversationId(conversationId);
  if (!row) return null;
  return row.last_message_id ?? null;
}

export function removeConversation(conversationId: string): void {
  prepareAndRun('DELETE FROM conversations WHERE conversation_id = ?', [conversationId]);
}

export function listExpiredConversationIds(maxAgeHours: number): string[] {
  const ageHours = Math.max(0, Math.floor(maxAgeHours));
  const rows = prepareAndAll<{ conversation_id: string }>(
    `
    SELECT latest.conversation_id
    FROM (
      SELECT conversation_id, MAX(last_used) AS latest_last_used
      FROM conversations
      GROUP BY conversation_id
    ) latest
    WHERE latest.latest_last_used < datetime('now', 'localtime', '-${ageHours} hours')
    ORDER BY latest.latest_last_used ASC
    `,
  );
  return rows.map((row) => row.conversation_id);
}

export function pruneOldConversations(maxAgeHours: number): number {
  const conversationIds = listExpiredConversationIds(maxAgeHours);
  for (const conversationId of conversationIds) {
    removeConversation(conversationId);
  }
  return conversationIds.length;
}
