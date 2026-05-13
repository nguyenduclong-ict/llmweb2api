import type { Provider, SessionContext } from '../../types/provider';
import type { InternalRequest, InternalResponse, InternalStreamChunk, InternalMessage } from '../../types/common';
import * as accountModel from '../../app/models/account';
import * as conversationModel from '../../app/models/conversation';
import { getSetting } from '../../app/services/settingsService';
import { filterTrackedMessages, hashMessages, hashTools } from './hash';

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providerRegistry.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
  return providerRegistry.get(name);
}

function resolveConversationFromPromptCache(request: InternalRequest): void {
  if (request.conversationId) return;
  if (!request.promptCacheKey) return;

  const existing = conversationModel.getByPromptCacheKey(request.promptCacheKey);
  if (existing) {
    request.conversationId = existing.conversation_id;
    console.log(
      `[PROMPT_CACHE] resolved conversationId=${existing.conversation_id} from prompt_cache_key=${request.promptCacheKey}`,
    );
  }
}

interface SessionEntry {
  providerSessionId: string;
  providerName: string;
  accountId: number;
  parentMessageId?: string;
  lastRequestMessageId?: string;
  seq?: number;
}

const sessionStore = new Map<string, SessionEntry>();

function getSession(conversationId: string): SessionEntry | undefined {
  return sessionStore.get(conversationId);
}

function saveSession(
  conversationId: string,
  providerSessionId: string,
  providerName: string,
  accountId: number,
  parentMessageId?: string,
  seq?: number,
): void {
  sessionStore.set(conversationId, { providerSessionId, providerName, accountId, parentMessageId, seq });
}

function emptyStream(): AsyncGenerator<InternalStreamChunk> {
  return (async function* () {})();
}

export async function processChat(
  providerName: string,
  request: InternalRequest,
  useCache?: boolean,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  resolveConversationFromPromptCache(request);

  console.log(
    `[FLOW] processChat: useCache=${useCache} convId=${request.conversationId || '<none>'} model=${request.model}`,
  );

  if (useCache) {
    return processChatWithCache(providerName, request, request.conversationId);
  }

  const provider = ensureProvider(providerName);
  const ctx = await createSession(provider, await selectAccount(providerName));
  ctx.metadata.conversationId = ctx.sessionId;

  try {
    const response = await provider.chat(ctx, request);
    response.conversationId = ctx.sessionId;
    return { response, accountId: ctx.accountId, conversationId: ctx.sessionId };
  } finally {
    await disposeTransientSession(provider, ctx);
  }
}

export async function processChatStream(
  providerName: string,
  request: InternalRequest,
  useCache?: boolean,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  resolveConversationFromPromptCache(request);

  console.log(
    `[FLOW] processChatStream: useCache=${useCache} convId=${request.conversationId || '<none>'} model=${request.model}`,
  );

  if (useCache) {
    return processChatStreamWithCache(providerName, request, request.conversationId, signal);
  }

  const provider = ensureProvider(providerName);
  if (signal?.aborted) return { stream: emptyStream(), accountId: 0, conversationId: '' };
  const ctx = await createSession(provider, await selectAccount(providerName));
  ctx.metadata.conversationId = ctx.sessionId;

  const innerStream = provider.chatStream(ctx, request, signal);

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        yield chunk;
      }
    } finally {
      await disposeTransientSession(provider, ctx);
    }
  }

  return { stream: wrappedStream(), accountId: ctx.accountId, conversationId: ctx.sessionId };
}

async function disposeTransientSession(provider: Provider, ctx: SessionContext): Promise<void> {
  try {
    await provider.dispose(ctx);
    console.log(`[CONV] Disposed transient ${provider.name} session ${ctx.sessionId}`);
  } catch (err) {
    console.error(`[CONV] Failed to dispose transient ${provider.name} session ${ctx.sessionId}:`, err);
  }
}

interface CachedConversation {
  conversationId: string;
  seq: number;
  providerName: string;
  providerSessionId: string;
  accountId: number;
  trackedCount: number;
  trackedHash: string;
  toolsHash: string | null;
  lastMessageId: string | null;
  baseTrackedCount: number;
  uploadedFileIds?: string[];
}

const conversationCache = new Map<string, CachedConversation>();

export function getCachedConversation(conversationId: string): CachedConversation | undefined {
  return conversationCache.get(conversationId);
}

export function hasConversation(conversationId: string): boolean {
  return conversationCache.has(conversationId) || !!conversationModel.getLatestByConversationId(conversationId);
}

export async function processChatWithCache(
  providerName: string,
  request: InternalRequest,
  conversationId?: string,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const publicConversationId = conversationId ?? `conv_${Date.now()}`;
  const state = getLatestState(publicConversationId);

  if (!state) {
    return startNewChat(providerName, request, publicConversationId, 0, 0);
  }

  const toolsHash = hashTools(request.tools as unknown[] | undefined);
  const decision = computeSendDecision(state, request.messages, toolsHash);
  if (decision.kind === 'fork') {
    console.log(`[CONV] ${decision.reason} for ${publicConversationId}; starting seq=${state.seq + 1}`);
    return startNewChat(providerName, request, publicConversationId, state.seq + 1, decision.baseTrackedCount);
  }
  if (decision.kind === 'empty') {
    return {
      response: emptyResponse(request.model, publicConversationId),
      accountId: state.accountId,
      conversationId: publicConversationId,
    };
  }

  const provider = ensureProvider(providerName);
  const ctx = await buildSessionContext(
    state.providerName,
    state.accountId,
    state.providerSessionId,
    publicConversationId,
  );
  ctx.metadata.parentMessageId = state.lastMessageId ?? undefined;
  ctx.metadata.conversationId = publicConversationId;

  const response = await provider.chat(ctx, {
    ...request,
    messages: decision.messagesToSend,
    originalMessages: request.messages,
  });
  const saved = persistStateFromContext(state, providerName, request, ctx, response);

  return {
    response: { ...response, conversationId: publicConversationId },
    accountId: saved.accountId,
    conversationId: publicConversationId,
  };
}

export async function processChatStreamWithCache(
  providerName: string,
  request: InternalRequest,
  conversationId?: string,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const publicConversationId = conversationId ?? `conv_${Date.now()}`;
  const state = getLatestState(publicConversationId);

  if (!state) {
    return startNewChatStream(providerName, request, publicConversationId, 0, 0, signal);
  }

  const toolsHash = hashTools(request.tools as unknown[] | undefined);
  const decision = computeSendDecision(state, request.messages, toolsHash);
  if (decision.kind === 'fork') {
    console.log(`[CONV] ${decision.reason} for ${publicConversationId}; starting seq=${state.seq + 1}`);
    return startNewChatStream(
      providerName,
      request,
      publicConversationId,
      state.seq + 1,
      decision.baseTrackedCount,
      signal,
    );
  }
  if (decision.kind === 'empty') {
    return { stream: emptyStream(), accountId: state.accountId, conversationId: publicConversationId };
  }

  const activeState = state;
  const provider = ensureProvider(providerName);
  const ctx = await buildSessionContext(
    activeState.providerName,
    activeState.accountId,
    activeState.providerSessionId,
    publicConversationId,
  );
  ctx.metadata.parentMessageId = activeState.lastMessageId ?? undefined;
  ctx.metadata.conversationId = publicConversationId;

  const innerStream = provider.chatStream(
    ctx,
    { ...request, messages: decision.messagesToSend, originalMessages: request.messages },
    signal,
  );
  const accountId = activeState.accountId;
  let hasMeaningfulChunk = false;

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        if (isMeaningfulChunk(chunk)) hasMeaningfulChunk = true;
        yield chunk;
      }
    } finally {
      if (hasMeaningfulChunk) {
        persistStateFromContext(activeState, providerName, request, ctx);
      } else {
        console.warn(
          `[CONV] skip persisting empty stream for ${activeState.conversationId}; ` +
            `provider=${providerName} session=${ctx.sessionId}`,
        );
      }
    }
  }

  return { stream: wrappedStream(), accountId, conversationId: publicConversationId };
}

export async function dumpConversation(conversationId: string): Promise<void> {
  const records = conversationModel.listByConversationId(conversationId);
  const state = getLatestState(conversationId);
  conversationCache.delete(conversationId);

  const entry = sessionStore.get(conversationId);
  const sessionsToDispose = new Map<
    string,
    { providerName: string; providerSessionId: string; accountId: number; uploadedFileIds: string[] }
  >();

  for (const record of records) {
    if (!record.provider || !record.account_id) continue;
    const metadata = parseJsonObject(record.metadata || '{}');
    const providerSessionId = metadata.providerSessionId as string | undefined;
    if (!providerSessionId) continue;
    sessionsToDispose.set(`${record.provider}:${record.account_id}:${providerSessionId}`, {
      providerName: record.provider,
      providerSessionId,
      accountId: record.account_id,
      uploadedFileIds: Array.isArray(metadata.uploadedFileIds)
        ? metadata.uploadedFileIds.filter((id): id is string => typeof id === 'string')
        : [],
    });
  }

  if (state?.providerName && state.providerSessionId && state.accountId) {
    sessionsToDispose.set(`${state.providerName}:${state.accountId}:${state.providerSessionId}`, {
      providerName: state.providerName,
      providerSessionId: state.providerSessionId,
      accountId: state.accountId,
      uploadedFileIds: state.uploadedFileIds ?? [],
    });
  }

  if (entry?.providerName && entry.providerSessionId && entry.accountId) {
    sessionsToDispose.set(`${entry.providerName}:${entry.accountId}:${entry.providerSessionId}`, {
      providerName: entry.providerName,
      providerSessionId: entry.providerSessionId,
      accountId: entry.accountId,
      uploadedFileIds: [],
    });
  }

  sessionStore.delete(conversationId);
  conversationModel.removeConversation(conversationId);

  for (const sessionToDispose of sessionsToDispose.values()) {
    try {
      const items = accountModel.getByProvider(sessionToDispose.providerName);
      const item = items.find((i) => i.id === sessionToDispose.accountId);
      if (!item) continue;
      const settings = parseJsonObject(item.settings);
      const session = parseJsonObject(item.session || '{}');
      const token = await ensureToken(sessionToDispose.providerName, { itemId: item.id, settings, session });
      const provider = ensureProvider(sessionToDispose.providerName);
      await provider.dispose({
        accountId: item.id,
        token,
        sessionId: sessionToDispose.providerSessionId,
        metadata: {
          accountSettings: settings,
          accountSession: session,
          uploadedFileIds: sessionToDispose.uploadedFileIds,
        },
      });
      console.log(
        `[CONV] Deleted ${sessionToDispose.providerName} session ${sessionToDispose.providerSessionId} for ${conversationId}`,
      );
    } catch (err) {
      console.error(`[CONV] Failed to delete provider session for ${conversationId}:`, err);
    }
  }
}

interface AccountSelection {
  itemId: number;
  settings: Record<string, unknown>;
  session: Record<string, unknown>;
}

const tokenCache = new Map<number, string>();

function ensureProvider(name: string): Provider {
  const provider = getProvider(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

async function selectAccount(providerName: string): Promise<AccountSelection> {
  const items = accountModel.getByProvider(providerName);
  const enabled = items.filter((i) => i.enabled);
  if (enabled.length === 0) throw new Error(`No enabled ${providerName} accounts`);

  const item = enabled[Math.floor(Math.random() * enabled.length)];
  return {
    itemId: item.id,
    settings: parseJsonObject(item.settings),
    session: parseJsonObject(item.session || '{}'),
  };
}

async function ensureToken(providerName: string, account: AccountSelection): Promise<string> {
  const cached = tokenCache.get(account.itemId);
  if (cached) {
    console.log(`[AUTH] Using cached token for account ${account.itemId}`);
    return cached;
  }

  const now = Date.now();
  const tokenExpiresAt = (account.session.tokenExpiresAt as number) || 0;
  let token = (account.session.token as string) || '';

  if (token && tokenExpiresAt > now) {
    console.log(
      `[AUTH] Using DB token for account ${account.itemId}, expires in ${Math.round((tokenExpiresAt - now) / 3600000)}h`,
    );
    tokenCache.set(account.itemId, token);
    return token;
  }

  const provider = ensureProvider(providerName);
  const ctx = await provider.login(account.settings);
  token = ctx.token;
  const expiresAt = now + 24 * 60 * 60 * 1000;
  accountModel.update(account.itemId, {
    session: { token, tokenExpiresAt: expiresAt },
  });
  console.log(`[AUTH] Token saved for account ${account.itemId}, expires in 24h`);
  tokenCache.set(account.itemId, token);
  return token;
}

async function createSession(provider: Provider, account: AccountSelection): Promise<SessionContext> {
  const token = await ensureToken(provider.name, account);
  const ctx = await provider.createSession({
    accountId: account.itemId,
    token,
    sessionId: '',
    metadata: { accountSettings: account.settings, accountSession: account.session },
  });
  console.log(`[CONV] New provider conversation created: ${ctx.sessionId}`);
  return ctx;
}

async function buildSessionContext(
  providerName: string,
  accountId: number,
  providerSessionId: string,
  conversationKey = providerSessionId,
): Promise<SessionContext> {
  const items = accountModel.getByProvider(providerName);
  const item = items.find((i) => i.id === accountId);
  if (!item) throw new Error(`Account ${accountId} not found`);

  const settings = parseJsonObject(item.settings);
  const session = parseJsonObject(item.session || '{}');
  const token = await ensureToken(providerName, { itemId: item.id, settings, session });
  const entry = getSession(conversationKey);
  return {
    accountId,
    token,
    sessionId: entry?.providerSessionId || providerSessionId,
    metadata: { parentMessageId: entry?.parentMessageId, accountSettings: settings, accountSession: session },
  };
}

async function startNewChat(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  seq: number,
  baseTrackedCount: number,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, providerName, account.itemId, undefined, seq);

  const response = await provider.chat(ctx, request);
  const state = createStateFromContext(conversationId, seq, providerName, request, ctx, response);
  state.baseTrackedCount = baseTrackedCount;
  saveState(state, request.promptCacheKey, response);

  return { response: { ...response, conversationId }, accountId: account.itemId, conversationId };
}

async function startNewChatStream(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  seq: number,
  baseTrackedCount: number,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  if (signal?.aborted) {
    return { stream: emptyStream(), accountId: account.itemId, conversationId };
  }
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, providerName, account.itemId, undefined, seq);

  const innerStream = provider.chatStream(ctx, request, signal);
  let hasMeaningfulChunk = false;

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        if (isMeaningfulChunk(chunk)) hasMeaningfulChunk = true;
        yield chunk;
      }
    } finally {
      if (hasMeaningfulChunk) {
        const state = createStateFromContext(conversationId, seq, providerName, request, ctx);
        state.baseTrackedCount = baseTrackedCount;
        saveState(state, request.promptCacheKey);
      } else {
        console.warn(
          `[CONV] skip saving empty new stream for ${conversationId}; provider=${providerName} session=${ctx.sessionId}`,
        );
      }
    }
  }

  return { stream: wrappedStream(), accountId: account.itemId, conversationId };
}

type SendDecision =
  | { kind: 'append'; messagesToSend: InternalMessage[] }
  | { kind: 'fork'; reason: string; baseTrackedCount: number }
  | { kind: 'empty' };

function computeSendDecision(
  state: CachedConversation,
  requestMessages: InternalMessage[],
  toolsHash: string | null,
): SendDecision {
  const toolsChanged = state.toolsHash !== toolsHash;
  if (toolsChanged) {
    console.log(
      `[CONV] tools changed for ${state.conversationId}; provider will refresh tool prompt ` +
        `previous=${state.toolsHash || '<none>'} current=${toolsHash || '<none>'}`,
    );
  }

  const tracked = filterTrackedMessages(requestMessages);
  const inputHash = hashMessages(tracked.slice(0, state.trackedCount));
  const maxMessages = getMaxMessagesPerConversation();
  const seqMessageCount = tracked.length - state.baseTrackedCount;

  console.log(
    `[CONV] state check conv=${state.conversationId} seq=${state.seq} tracked=${tracked.length} ` +
      `storedCount=${state.trackedCount} seqCount=${seqMessageCount} max=${maxMessages || '<disabled>'} ` +
      `prefixMatch=${inputHash === state.trackedHash}`,
  );

  if (inputHash !== state.trackedHash) {
    return { kind: 'fork', reason: 'prefix changed', baseTrackedCount: 0 };
  }

  const firstNewTracked = tracked[state.trackedCount];
  if (!firstNewTracked) {
    return { kind: 'empty' };
  }

  if (maxMessages > 0 && seqMessageCount > maxMessages) {
    return {
      kind: 'fork',
      reason: `max messages exceeded (${seqMessageCount}/${maxMessages})`,
      baseTrackedCount: state.trackedCount,
    };
  }

  const originalIndex = requestMessages.indexOf(firstNewTracked);
  const messagesToSend = requestMessages.slice(originalIndex >= 0 ? originalIndex : 0);
  return { kind: 'append', messagesToSend };
}

function createStateFromContext(
  conversationId: string,
  seq: number,
  providerName: string,
  request: InternalRequest,
  ctx: SessionContext,
  response?: InternalResponse,
): CachedConversation {
  const tracked = filterTrackedMessages(request.messages);
  const lastMessageId = ctx.metadata.lastResponseMessageId
    ? String(ctx.metadata.lastResponseMessageId)
    : (response?.conversationId ?? null);

  return {
    conversationId,
    seq,
    providerName,
    providerSessionId: ctx.sessionId,
    accountId: ctx.accountId,
    trackedCount: tracked.length,
    trackedHash: hashMessages(tracked),
    toolsHash: hashTools(request.tools as unknown[] | undefined),
    lastMessageId,
    baseTrackedCount: 0,
    uploadedFileIds: Array.isArray(ctx.metadata.uploadedFileIds)
      ? (ctx.metadata.uploadedFileIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function persistStateFromContext(
  state: CachedConversation,
  providerName: string,
  request: InternalRequest,
  ctx: SessionContext,
  response?: InternalResponse,
): CachedConversation {
  const saved = createStateFromContext(state.conversationId, state.seq, providerName, request, ctx, response);
  saved.accountId = state.accountId;
  saved.providerSessionId = state.providerSessionId;
  saved.baseTrackedCount = state.baseTrackedCount;
  saved.uploadedFileIds = [...(state.uploadedFileIds ?? []), ...(saved.uploadedFileIds ?? [])].filter(
    (id, index, arr) => arr.indexOf(id) === index,
  );
  if (!saved.lastMessageId) saved.lastMessageId = state.lastMessageId;
  saveState(saved, request.promptCacheKey, response);
  return saved;
}

function saveState(state: CachedConversation, promptCacheKey?: string, response?: InternalResponse): void {
  conversationCache.set(state.conversationId, state);
  saveSession(
    state.conversationId,
    state.providerSessionId,
    state.providerName,
    state.accountId,
    state.lastMessageId ?? undefined,
    state.seq,
  );
  if (response?.usage) {
    conversationModel.saveConversationState({
      conversationId: state.conversationId,
      seq: state.seq,
      accountId: state.accountId,
      providerName: state.providerName,
      metadata: {
        providerSessionId: state.providerSessionId,
        baseTrackedCount: state.baseTrackedCount,
        uploadedFileIds: state.uploadedFileIds ?? [],
      },
      trackedCount: state.trackedCount,
      trackedHash: state.trackedHash,
      toolsHash: state.toolsHash,
      lastMessageId: state.lastMessageId,
      inputTokens: response.usage.cumulativeInputTokens ?? response.usage.inputTokens,
      outputTokens: response.usage.cumulativeOutputTokens ?? response.usage.outputTokens,
      promptCacheKey,
    });
    return;
  }

  conversationModel.saveConversationState({
    conversationId: state.conversationId,
    seq: state.seq,
    accountId: state.accountId,
    providerName: state.providerName,
    metadata: {
      providerSessionId: state.providerSessionId,
      baseTrackedCount: state.baseTrackedCount,
      uploadedFileIds: state.uploadedFileIds ?? [],
    },
    trackedCount: state.trackedCount,
    trackedHash: state.trackedHash,
    toolsHash: state.toolsHash,
    lastMessageId: state.lastMessageId,
    promptCacheKey,
  });
}

function isMeaningfulChunk(chunk: InternalStreamChunk): boolean {
  return !!(
    chunk.content ||
    chunk.reasoningContent ||
    chunk.toolCallDelta ||
    (chunk.toolCalls && chunk.toolCalls.length > 0)
  );
}

function getLatestState(conversationId: string): CachedConversation | undefined {
  const cached = conversationCache.get(conversationId);
  if (cached) return cached;
  return loadState(conversationId);
}

function loadState(conversationId: string): CachedConversation | undefined {
  const row = conversationModel.getLatestByConversationId(conversationId);
  if (!row || !row.provider || !row.account_id) return undefined;

  const metadata = parseJsonObject(row.metadata || '{}');
  const providerSessionId = metadata.providerSessionId as string | undefined;
  const baseTrackedCount =
    typeof metadata.baseTrackedCount === 'number' && Number.isFinite(metadata.baseTrackedCount)
      ? metadata.baseTrackedCount
      : 0;
  if (!providerSessionId) return undefined;

  const state: CachedConversation = {
    conversationId: row.conversation_id,
    seq: row.seq ?? 0,
    providerName: row.provider,
    providerSessionId,
    accountId: row.account_id,
    trackedCount: row.tracked_count ?? 0,
    trackedHash: row.tracked_hash ?? '',
    toolsHash: row.tools_hash || null,
    lastMessageId: row.last_message_id ?? null,
    baseTrackedCount,
    uploadedFileIds: Array.isArray(metadata.uploadedFileIds)
      ? metadata.uploadedFileIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
  conversationCache.set(conversationId, state);
  saveSession(
    conversationId,
    state.providerSessionId,
    state.providerName,
    state.accountId,
    state.lastMessageId ?? undefined,
    state.seq,
  );
  return state;
}

function emptyResponse(model: string, conversationId: string): InternalResponse {
  return {
    id: `empty-${Date.now()}`,
    model,
    content: '',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
    conversationId,
  };
}

function getMaxMessagesPerConversation(): number {
  const raw = getSetting('max_messages_per_conversation', '30')?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
