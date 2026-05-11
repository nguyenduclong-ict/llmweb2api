import type { Provider, SessionContext } from '../../types/provider';
import type { InternalRequest, InternalResponse, InternalStreamChunk, InternalMessage } from '../../types/common';
import * as accountModel from '../../app/models/account';
import * as conversationModel from '../../app/models/conversation';
import { hashMessage, filterTrackedMessages, hashTools, updateHashCacheParentId, type HashCacheMap } from './hash';

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providerRegistry.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
  return providerRegistry.get(name);
}

// --- Prompt Cache Key Resolution ---

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

function storePromptCacheKey(conversationId: string, promptCacheKey?: string): void {
  if (!promptCacheKey || !conversationId) return;
  conversationModel.updatePromptCacheKey(conversationId, promptCacheKey);
  console.log(`[PROMPT_CACHE] stored prompt_cache_key=${promptCacheKey} for conversationId=${conversationId}`);
}

// --- Session Reuse (shared by cache & non-cache flows) ---

interface SessionEntry {
  providerSessionId: string;
  providerName: string;
  accountId: number;
  parentMessageId?: string;
  lastRequestMessageId?: string;
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
): void {
  sessionStore.set(conversationId, { providerSessionId, providerName, accountId, parentMessageId });
}

function updateSessionParent(conversationId: string, parentMessageId: string): void {
  const entry = sessionStore.get(conversationId);
  if (entry) {
    entry.parentMessageId = parentMessageId;
  }
}

function updateSessionLastRequestId(conversationId: string, lastRequestMessageId: string): void {
  const entry = sessionStore.get(conversationId);
  if (entry) {
    entry.lastRequestMessageId = lastRequestMessageId;
  }
}

// --- No-Cache Flow ---

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
  const isNew = !request.conversationId;
  console.log(`[FLOW] processChat non-cache: isNew=${isNew} convId=${request.conversationId || '<none>'}`);
  const ctx = isNew
    ? await createSession(provider, await selectAccount(providerName))
    : await reuseSession(providerName, request.conversationId!);

  if (isNew) {
    ctx.metadata.conversationId = ctx.sessionId;
    saveSession(ctx.sessionId, ctx.sessionId, providerName, ctx.accountId);
    storePromptCacheKey(ctx.sessionId, request.promptCacheKey);
  }

  const response = await provider.chat(ctx, request);
  response.conversationId = request.conversationId || ctx.sessionId;

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
  }

  return { response, accountId: ctx.accountId, conversationId: request.conversationId || ctx.sessionId };
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
  const isNew = !request.conversationId;
  console.log(`[FLOW] processChatStream non-cache: isNew=${isNew} convId=${request.conversationId || '<none>'}`);
  if (signal?.aborted) return { stream: emptyStream(), accountId: 0, conversationId: '' };
  const ctx = isNew
    ? await createSession(provider, await selectAccount(providerName))
    : await reuseSession(providerName, request.conversationId!);

  if (isNew) {
    ctx.metadata.conversationId = ctx.sessionId;
    saveSession(ctx.sessionId, ctx.sessionId, providerName, ctx.accountId);
    storePromptCacheKey(ctx.sessionId, request.promptCacheKey);
  }

  const innerStream = provider.chatStream(ctx, request, signal);

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId) {
        updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(ctx.sessionId, ctx.metadata.lastRequestMessageId as string);
      }
    }
  }

  return { stream: wrappedStream(), accountId: ctx.accountId, conversationId: request.conversationId || ctx.sessionId };
}

async function reuseSession(providerName: string, conversationId: string): Promise<SessionContext> {
  const entry = getSession(conversationId);
  if (entry) {
    console.log(`[CONV] Reusing session: ${entry.providerSessionId}`);
    return buildSessionContext(entry.providerName, entry.accountId, entry.providerSessionId, conversationId);
  }

  // Session not in memory — rebuild from DB or start fresh
  console.log(`[CONV] ${conversationId} not in sessionStore, checking DB`);

  const hashCache = conversationModel.loadHashCache(conversationId);
  if (hashCache) {
    // DB has hash cache — restore existing DeepSeek session (không tạo mới)
    const { ctx } = await restoreSessionContext(providerName, conversationId);
    return ctx;
  }

  // No DB entry — start fresh but preserve original conversationId as key
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  console.log(`[CONV] ${conversationId} not in DB, creating new ${providerName} session`);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, providerName, account.itemId);
  return ctx;
}

// --- Cache-Aware Flow ---

interface CachedConversation {
  conversationId: string;
  accountId: number;
  hashCache: HashCacheMap;
  toolsHash: string | null;
  lastMessageId: string | null;
}

const conversationCache = new Map<string, CachedConversation>();

export function getCachedConversation(conversationId: string): CachedConversation | undefined {
  return conversationCache.get(conversationId);
}

export function hasConversation(conversationId: string): boolean {
  return conversationCache.has(conversationId);
}

export async function processChatWithCache(
  providerName: string,
  request: InternalRequest,
  conversationId?: string,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  if (conversationId) {
    return processCachedChat(providerName, request, conversationId);
  }
  return processFirstCachedChat(providerName, request);
}

export async function processChatStreamWithCache(
  providerName: string,
  request: InternalRequest,
  conversationId?: string,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  if (conversationId) {
    return processCachedChatStream(providerName, request, conversationId, signal);
  }
  return processFirstCachedChatStream(providerName, request, signal);
}

export async function dumpConversation(conversationId: string): Promise<void> {
  conversationCache.delete(conversationId);
  conversationModel.removeConversation(conversationId);

  const entry = sessionStore.get(conversationId);
  if (entry) {
    sessionStore.delete(conversationId);
    try {
      const items = accountModel.getByProvider(entry.providerName);
      const item = items.find((i) => i.id === entry.accountId);
      if (item) {
        let session: Record<string, unknown>;
        let settings: Record<string, unknown>;
        try {
          session = JSON.parse(item.session || '{}');
        } catch {
          session = {};
        }
        try {
          settings = JSON.parse(item.settings || '{}');
        } catch {
          settings = {};
        }
        const token = await ensureToken(entry.providerName, { itemId: item.id, settings, session });
        const provider = ensureProvider(entry.providerName);
        await provider.dispose({ accountId: item.id, token, sessionId: entry.providerSessionId, metadata: {} });
        console.log(`[CONV] Deleted ${entry.providerName} session ${entry.providerSessionId} for ${conversationId}`);
      }
    } catch (err) {
      console.error(`[CONV] Failed to delete provider session for ${conversationId}:`, err);
    }
  }
}

// --- Internal: Auth + Session ---

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
  let settings: Record<string, unknown>;
  let session: Record<string, unknown>;
  try {
    settings = JSON.parse(item.settings);
  } catch {
    settings = {};
  }
  try {
    session = JSON.parse(item.session || '{}');
  } catch {
    session = {};
  }

  return { itemId: item.id, settings, session };
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

  if (token && tokenExpiresAt <= now) {
    console.log(`[AUTH] Token expired for account ${account.itemId}, logging in...`);
  } else {
    console.log(`[AUTH] No token for account ${account.itemId}, logging in...`);
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
  const ctx = await provider.createSession({ accountId: account.itemId, token, sessionId: '', metadata: {} });
  console.log(`[CONV] New conversation created: ${ctx.sessionId}`);
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

  let settings: Record<string, unknown>;
  let session: Record<string, unknown>;
  try {
    settings = JSON.parse(item.settings);
  } catch {
    settings = {};
  }
  try {
    session = JSON.parse(item.session || '{}');
  } catch {
    session = {};
  }

  const token = await ensureToken(providerName, { itemId: item.id, settings, session });
  const entry = getSession(conversationKey);
  return {
    accountId,
    token,
    sessionId: entry?.providerSessionId || providerSessionId,
    metadata: { parentMessageId: entry?.parentMessageId },
  };
}

// --- First Cached Request (new conversation) ---

async function processFirstCachedChat(
  providerName: string,
  request: InternalRequest,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = ctx.sessionId;
  saveSession(ctx.sessionId, ctx.sessionId, providerName, account.itemId);
  storePromptCacheKey(ctx.sessionId, request.promptCacheKey);

  const response = await provider.chat(ctx, request);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
  }
  if (ctx.metadata.lastRequestMessageId) {
    updateSessionLastRequestId(ctx.sessionId, ctx.metadata.lastRequestMessageId as string);
  }

  const lastMessageId = ctx.metadata.lastResponseMessageId ? String(ctx.metadata.lastResponseMessageId) : null;
  const hashCache = buildHashCacheFromRequest(request, ctx.metadata);
  const toolsHash = hashTools(request.tools as unknown[] | undefined);

  conversationCache.set(ctx.sessionId, {
    conversationId: ctx.sessionId,
    accountId: account.itemId,
    hashCache,
    toolsHash,
    lastMessageId,
  });
  conversationModel.saveHashCache(
    ctx.sessionId,
    account.itemId,
    providerName,
    hashCache,
    toolsHash,
    lastMessageId,
    response.usage.cumulativeInputTokens,
    response.usage.cumulativeOutputTokens,
  );

  return {
    response: { ...response, conversationId: ctx.sessionId },
    accountId: account.itemId,
    conversationId: ctx.sessionId,
  };
}

async function processFirstCachedChatStream(
  providerName: string,
  request: InternalRequest,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  if (signal?.aborted) {
    return { stream: emptyStream(), accountId: account.itemId, conversationId: '' };
  }
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = ctx.sessionId;
  saveSession(ctx.sessionId, ctx.sessionId, providerName, account.itemId);
  storePromptCacheKey(ctx.sessionId, request.promptCacheKey);

  const innerStream = provider.chatStream(ctx, request, signal);
  const toolsHash = hashTools(request.tools as unknown[] | undefined);

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    let saved = false;
    let lastMsgSaved = false;
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        if (!saved) {
          saved = true;
          const lastMessageId = ctx.metadata.lastResponseMessageId ? String(ctx.metadata.lastResponseMessageId) : null;
          const hashCache = buildHashCacheFromRequest(request, ctx.metadata);
          conversationCache.set(ctx.sessionId, {
            conversationId: ctx.sessionId,
            accountId: account.itemId,
            hashCache,
            toolsHash,
            lastMessageId,
          });
          conversationModel.saveHashCache(
            ctx.sessionId,
            account.itemId,
            providerName,
            hashCache,
            toolsHash,
            lastMessageId,
          );
          if (lastMessageId !== null) {
            lastMsgSaved = true;
            updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
          }
        }
        // Cập nhật lastMessageId ngay khi có, không đợi finally
        if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
          lastMsgSaved = true;
          updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
          const conv = conversationCache.get(ctx.sessionId);
          if (conv) {
            conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
            conversationModel.saveHashCache(
              ctx.sessionId,
              account.itemId,
              providerName,
              conv.hashCache,
              toolsHash,
              conv.lastMessageId,
            );
          }
        }
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
        updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
        const conv = conversationCache.get(ctx.sessionId);
        if (conv) {
          conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
          conversationModel.saveHashCache(
            ctx.sessionId,
            account.itemId,
            providerName,
            conv.hashCache,
            toolsHash,
            conv.lastMessageId,
          );
        }
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(ctx.sessionId, ctx.metadata.lastRequestMessageId as string);
      }
    }
  }

  return { stream: wrappedStream(), accountId: account.itemId, conversationId: ctx.sessionId };
}

// --- Subsequent Cached Request ---

async function processCachedChat(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const cached = conversationCache.get(conversationId);

  if (!cached) {
    console.log(`[FLOW] processCachedChat: ${conversationId} not in memory, checking DB`);
    const hashCache = conversationModel.loadHashCache(conversationId);
    if (!hashCache) {
      const dbMessages = conversationModel.loadMessages(conversationId);
      if (!dbMessages || dbMessages.length === 0) {
        console.log(`[FLOW] processCachedChat: ${conversationId} NOT in DB either → NEW conversation`);
        return processFirstCachedChat(providerName, request);
      }
      console.log(`[FLOW] processCachedChat: ${conversationId} found legacy messages in DB → restore legacy`);
      return handleDbRestoreChat(providerName, request, conversationId, dbMessages);
    }
    console.log(`[FLOW] processCachedChat: ${conversationId} found hashCache in DB → restore with hash`);
    return handleDbRestoreWithHash(providerName, request, conversationId, hashCache);
  }

  const cachedCount = Object.keys(cached.hashCache).length;
  const diff = computeHashDiff(cached.hashCache, request.messages, cachedCount, cached.lastMessageId);
  const provider = ensureProvider(providerName);

  const newToolsHash = hashTools(request.tools as unknown[] | undefined);
  const toolsChanged = newToolsHash !== null && newToolsHash !== cached.toolsHash;

  // All messages match → regenerate
  if (diff.isFullMatch) {
    console.log(`[CONV] Full hash match for ${conversationId}, regenerating`);
    const ctx = await buildSessionContext(providerName, cached.accountId, conversationId);
    ctx.metadata.parentMessageId = undefined;
    ctx.metadata.conversationId = conversationId;
    attachCachedImageSummaries(ctx, cached.hashCache, request.messages);

    const response = await provider.chat(ctx, request);

    if (ctx.metadata.lastResponseMessageId) {
      updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
      cached.lastMessageId = String(ctx.metadata.lastResponseMessageId);
      updateHashCacheParentId(cached.hashCache, request.messages, cached.lastMessageId);
    }
    if (ctx.metadata.lastRequestMessageId) {
      updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
    }

    return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
  }

  const isRevert = diff.matchedCount < cachedCount;
  console.log(
    `[DIFF] hash matched=${diff.matchedCount} cached=${cachedCount} ` +
      `new=${diff.messagesToSend.length} revert=${isRevert}`,
  );

  // Revert: prune hash entries after divergence, use edit flow
  if (isRevert) {
    pruneHashCache(cached.hashCache, diff.lastMatchedHash);

    const ctx = await buildSessionContext(providerName, cached.accountId, conversationId);
    ctx.metadata.parentMessageId = diff.parentMessageId;
    ctx.metadata.conversationId = conversationId;
    attachCachedImageSummaries(ctx, cached.hashCache, request.messages);

    const response = await provider.chat(ctx, request);

    if (ctx.metadata.lastResponseMessageId) {
      updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
      cached.lastMessageId = String(ctx.metadata.lastResponseMessageId);
      updateHashCacheParentId(cached.hashCache, request.messages, cached.lastMessageId);
    }
    if (ctx.metadata.lastRequestMessageId) {
      updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
    }

    addRequestToHashCache(cached.hashCache, request.messages, ctx.metadata);
    if (toolsChanged) cached.toolsHash = newToolsHash;
    conversationModel.saveHashCache(
      conversationId,
      cached.accountId,
      providerName,
      cached.hashCache,
      cached.toolsHash,
      cached.lastMessageId,
    );

    return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
  }

  // Normal append: send only new messages
  const ctx = await buildSessionContext(providerName, cached.accountId, conversationId);
  ctx.metadata.parentMessageId = diff.parentMessageId;
  ctx.metadata.conversationId = conversationId;
  attachCachedImageSummaries(ctx, cached.hashCache, request.messages);

  const diffRequest: InternalRequest = { ...request, messages: diff.messagesToSend };
  const response = await provider.chat(ctx, diffRequest);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
    cached.lastMessageId = String(ctx.metadata.lastResponseMessageId);
    updateHashCacheParentId(cached.hashCache, request.messages, cached.lastMessageId);
  }
  if (ctx.metadata.lastRequestMessageId) {
    updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
  }

  addRequestToHashCache(cached.hashCache, request.messages, ctx.metadata);
  if (toolsChanged) cached.toolsHash = newToolsHash;
  conversationModel.saveHashCache(
    conversationId,
    cached.accountId,
    providerName,
    cached.hashCache,
    cached.toolsHash,
    cached.lastMessageId,
  );

  return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
}

async function processCachedChatStream(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const cached = conversationCache.get(conversationId);

  if (!cached) {
    console.log(`[FLOW] processCachedChatStream: ${conversationId} not in memory, checking DB`);
    const hashCache = conversationModel.loadHashCache(conversationId);
    if (!hashCache) {
      const dbMessages = conversationModel.loadMessages(conversationId);
      if (!dbMessages || dbMessages.length === 0) {
        console.log(`[FLOW] processCachedChatStream: ${conversationId} NOT in DB either → NEW conversation`);
        return processFirstCachedChatStream(providerName, request);
      }
      console.log(`[FLOW] processCachedChatStream: ${conversationId} found legacy messages in DB → restore legacy`);
      return handleDbRestoreChatStream(providerName, request, conversationId, dbMessages, signal);
    }
    console.log(`[FLOW] processCachedChatStream: ${conversationId} found hashCache in DB → restore with hash`);
    return handleDbRestoreStreamWithHash(providerName, request, conversationId, hashCache, signal);
  }

  // Capture reference for closures
  const conv = cached;

  const cachedCount = Object.keys(conv.hashCache).length;
  const diff = computeHashDiff(conv.hashCache, request.messages, cachedCount, conv.lastMessageId);
  const provider = ensureProvider(providerName);

  const newToolsHash = hashTools(request.tools as unknown[] | undefined);
  const toolsChanged = newToolsHash !== null && newToolsHash !== conv.toolsHash;

  // All messages match → regenerate via edit_message
  if (diff.isFullMatch) {
    if (!hasPendingInput(request.messages)) {
      console.log(
        `[CONV] Full hash match for ${conversationId}, no pending user/tool input ` +
          `(lastRole=${lastNonSystemRole(request.messages) ?? '<none>'}) - skipping provider call`,
      );
      if (toolsChanged) {
        conv.toolsHash = newToolsHash;
        conversationModel.saveHashCache(
          conversationId,
          conv.accountId,
          providerName,
          conv.hashCache,
          conv.toolsHash,
          conv.lastMessageId,
        );
      }
      return { stream: emptyStream(), accountId: conv.accountId, conversationId };
    }

    const entry = getSession(conversationId);
    const lastReqId = entry?.lastRequestMessageId;
    if (lastReqId) {
      console.log(`[CONV] Full hash match for ${conversationId}, regenerating via edit_message id=${lastReqId}`);
    } else {
      console.log(`[CONV] Full hash match for ${conversationId}, regenerating (no edit id, full regenerate)`);
    }
    const ctx = await buildSessionContext(providerName, conv.accountId, conversationId);
    ctx.metadata.editMessageId = lastReqId ?? undefined;
    ctx.metadata.conversationId = conversationId;
    attachCachedImageSummaries(ctx, conv.hashCache, request.messages);

    const innerStream = provider.chatStream(ctx, request, signal);
    const accountId = conv.accountId;

    async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
      let saved = false;
      let lastMsgSaved = false;
      try {
        for await (const chunk of innerStream) {
          if (signal?.aborted) return;
          if (!saved) {
            saved = true;
            if (toolsChanged) conv.toolsHash = newToolsHash;
            conversationModel.saveHashCache(
              conversationId,
              accountId,
              providerName,
              conv.hashCache,
              conv.toolsHash,
              conv.lastMessageId,
            );
            if (ctx.metadata.lastResponseMessageId) {
              lastMsgSaved = true;
              updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
              conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
              updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
              conversationModel.saveHashCache(
                conversationId,
                accountId,
                providerName,
                conv.hashCache,
                conv.toolsHash,
                conv.lastMessageId,
              );
            }
          }
          if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
            lastMsgSaved = true;
            updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
            conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
            conversationModel.saveHashCache(
              conversationId,
              accountId,
              providerName,
              conv.hashCache,
              conv.toolsHash,
              conv.lastMessageId,
            );
          }
          yield chunk;
        }
      } finally {
        if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
          conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
          conversationModel.saveHashCache(
            conversationId,
            accountId,
            providerName,
            conv.hashCache,
            conv.toolsHash,
            conv.lastMessageId,
          );
        }
        if (ctx.metadata.lastRequestMessageId) {
          updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
        }
      }
    }

    return { stream: wrappedStream(), accountId, conversationId };
  }

  const isRevert = diff.matchedCount < cachedCount;
  console.log(
    `[DIFF] hash matched=${diff.matchedCount} cached=${cachedCount} ` +
      `new=${diff.messagesToSend.length} revert=${isRevert}`,
  );

  // Revert: prune hash entries after divergence, use edit_message
  if (isRevert) {
    pruneHashCache(conv.hashCache, diff.lastMatchedHash);

    const entry = getSession(conversationId);
    const lastReqId = entry?.lastRequestMessageId;
    const editMsgId = diff.matchedCount > 0 ? diff.parentMessageId : undefined;
    const useEditId = lastReqId ?? editMsgId ?? undefined;

    const ctx = await buildSessionContext(providerName, conv.accountId, conversationId);
    ctx.metadata.editMessageId = useEditId;
    ctx.metadata.parentMessageId = diff.parentMessageId;
    ctx.metadata.conversationId = conversationId;
    attachCachedImageSummaries(ctx, conv.hashCache, request.messages);

    const innerStream = provider.chatStream(ctx, request, signal);
    const accountId = conv.accountId;

    async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
      let saved = false;
      let lastMsgSaved = false;
      try {
        for await (const chunk of innerStream) {
          if (signal?.aborted) return;
          if (!saved) {
            saved = true;
            addRequestToHashCache(conv.hashCache, request.messages, ctx.metadata);
            if (toolsChanged) conv.toolsHash = newToolsHash;
            conversationModel.saveHashCache(
              conversationId,
              accountId,
              providerName,
              conv.hashCache,
              conv.toolsHash,
              conv.lastMessageId,
            );
            if (ctx.metadata.lastResponseMessageId) {
              lastMsgSaved = true;
              updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
              conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
              updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
              conversationModel.saveHashCache(
                conversationId,
                accountId,
                providerName,
                conv.hashCache,
                conv.toolsHash,
                conv.lastMessageId,
              );
            }
          }
          if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
            lastMsgSaved = true;
            updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
            conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
            conversationModel.saveHashCache(
              conversationId,
              accountId,
              providerName,
              conv.hashCache,
              conv.toolsHash,
              conv.lastMessageId,
            );
          }
          yield chunk;
        }
      } finally {
        if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
          conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
          conversationModel.saveHashCache(
            conversationId,
            accountId,
            providerName,
            conv.hashCache,
            conv.toolsHash,
            conv.lastMessageId,
          );
        }
        if (ctx.metadata.lastRequestMessageId) {
          updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
        }
        if (!saved) {
          conversationModel.saveHashCache(
            conversationId,
            accountId,
            providerName,
            conv.hashCache,
            conv.toolsHash,
            conv.lastMessageId,
          );
        }
      }
    }

    return { stream: wrappedStream(), accountId, conversationId };
  }

  // Normal append: send only new messages
  console.log(
    `[CONV] NORMAL_APPEND convId=${conversationId} parentMsgId=${diff.parentMessageId} ` +
      `msgsToSend=${diff.messagesToSend.length} roles=[${diff.messagesToSend.map((m) => m.role).join(',')}]`,
  );
  const ctx = await buildSessionContext(providerName, conv.accountId, conversationId);
  ctx.metadata.parentMessageId = diff.parentMessageId;
  ctx.metadata.conversationId = conversationId;
  attachCachedImageSummaries(ctx, conv.hashCache, request.messages);

  const diffRequest: InternalRequest = { ...request, messages: diff.messagesToSend };
  const innerStream = provider.chatStream(ctx, diffRequest, signal);
  const accountId = conv.accountId;

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    let saved = false;
    let lastMsgSaved = false;
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        if (!saved) {
          saved = true;
          addRequestToHashCache(conv.hashCache, request.messages, ctx.metadata);
          if (toolsChanged) conv.toolsHash = newToolsHash;
          conversationModel.saveHashCache(
            conversationId,
            accountId,
            providerName,
            conv.hashCache,
            conv.toolsHash,
            conv.lastMessageId,
          );
          if (ctx.metadata.lastResponseMessageId) {
            lastMsgSaved = true;
            updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
            conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
            conversationModel.saveHashCache(
              conversationId,
              accountId,
              providerName,
              conv.hashCache,
              conv.toolsHash,
              conv.lastMessageId,
            );
          }
        }
        if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
          lastMsgSaved = true;
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
          conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
          conversationModel.saveHashCache(
            conversationId,
            accountId,
            providerName,
            conv.hashCache,
            conv.toolsHash,
            conv.lastMessageId,
          );
        }
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
        updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
        conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
        updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
        conversationModel.saveHashCache(
          conversationId,
          accountId,
          providerName,
          conv.hashCache,
          conv.toolsHash,
          conv.lastMessageId,
        );
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
      }
      if (!saved) {
        conversationModel.saveHashCache(
          conversationId,
          accountId,
          providerName,
          conv.hashCache,
          conv.toolsHash,
          conv.lastMessageId,
        );
      }
    }
  }

  return { stream: wrappedStream(), accountId, conversationId };
}

// --- DB Restore (after server restart) ---

async function restoreSessionContext(
  providerName: string,
  conversationId: string,
  parentMessageIdOverride?: string | null,
): Promise<{ ctx: SessionContext; account: AccountSelection }> {
  ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const token = await ensureToken(providerName, account);
  const lastMessageId = parentMessageIdOverride ?? conversationModel.loadLastMessageId(conversationId);
  const tokenStats = conversationModel.loadTokenStats(conversationId);
  const ctx: SessionContext = {
    accountId: account.itemId,
    token,
    sessionId: conversationId,
    metadata: {
      parentMessageId: lastMessageId ?? undefined,
      conversationId,
      isRestoredSession: true,
      ...(tokenStats
        ? { cumulativeInputTokens: tokenStats.inputTokens, cumulativeOutputTokens: tokenStats.outputTokens }
        : {}),
    },
  };
  saveSession(conversationId, conversationId, providerName, account.itemId, String(lastMessageId || ''));
  console.log(`[CONV] Restored existing session: ${conversationId} parentMsgId=${lastMessageId || '<none>'}`);
  return { ctx, account };
}

async function handleDbRestoreChat(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  dbMessages: InternalMessage[],
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  // Migrate legacy messages → hash cache, then delegate to hash handler
  const hashCache = buildHashCacheFromMessages(dbMessages);
  return handleDbRestoreWithHash(providerName, request, conversationId, hashCache);
}

async function handleDbRestoreChatStream(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  dbMessages: InternalMessage[],
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  // Migrate legacy messages → hash cache, then delegate to hash handler
  const hashCache = buildHashCacheFromMessages(dbMessages);
  return handleDbRestoreStreamWithHash(providerName, request, conversationId, hashCache, signal);
}

async function handleDbRestoreWithHash(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  hashCache: HashCacheMap,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const cachedCount = Object.keys(hashCache).length;
  const lastMessageId = resolveLatestMessageId(hashCache, conversationModel.loadLastMessageId(conversationId));
  const diff = computeHashDiff(hashCache, request.messages, cachedCount, lastMessageId);

  const newToolsHash = hashTools(request.tools as unknown[] | undefined);
  const existingToolsHash = conversationModel.loadToolsHash(conversationId);
  const toolsChanged = newToolsHash !== null && newToolsHash !== existingToolsHash;
  const finalToolsHash = toolsChanged ? newToolsHash : existingToolsHash;

  // Full match: regenerate toàn bộ
  if (diff.isFullMatch) {
    console.log(`[CONV] DB full hash match for ${conversationId}, regenerating`);
    const { ctx, account } = await restoreSessionContext(providerName, conversationId, lastMessageId);
    ctx.metadata.parentMessageId = undefined;
    ctx.metadata.toolsChanged = toolsChanged;
    attachCachedImageSummaries(ctx, hashCache, request.messages);

    const response = await provider.chat(ctx, request);

    if (ctx.metadata.lastResponseMessageId) {
      updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
    }
    if (ctx.metadata.lastRequestMessageId) {
      updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
    }

    return { response: { ...response, conversationId }, accountId: account.itemId, conversationId };
  }

  const isRevert = diff.matchedCount < cachedCount;
  console.log(
    `[DIFF] DB hash matched=${diff.matchedCount} cached=${cachedCount} ` +
      `new=${diff.messagesToSend.length} revert=${isRevert}`,
  );

  if (isRevert) {
    pruneHashCache(hashCache, diff.lastMatchedHash);
  }

  // Normal append or revert: restore session, send messagesToSend
  const { ctx, account } = await restoreSessionContext(providerName, conversationId, lastMessageId);
  ctx.metadata.parentMessageId = diff.parentMessageId;
  ctx.metadata.toolsChanged = toolsChanged || isRevert;
  attachCachedImageSummaries(ctx, hashCache, request.messages);

  const diffRequest: InternalRequest = { ...request, messages: diff.messagesToSend };
  const response = await provider.chat(ctx, diffRequest);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
    const newLastId = String(ctx.metadata.lastResponseMessageId);
    addRequestToHashCache(hashCache, request.messages, ctx.metadata);
    updateHashCacheParentId(hashCache, request.messages, newLastId);
    conversationCache.set(conversationId, {
      conversationId,
      accountId: account.itemId,
      hashCache,
      toolsHash: newToolsHash,
      lastMessageId: newLastId,
    });
    conversationModel.saveHashCache(
      conversationId,
      account.itemId,
      providerName,
      hashCache,
      finalToolsHash,
      newLastId,
      response.usage.cumulativeInputTokens,
      response.usage.cumulativeOutputTokens,
    );
  }
  if (ctx.metadata.lastRequestMessageId) {
    updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
  }

  return { response: { ...response, conversationId }, accountId: account.itemId, conversationId };
}

async function handleDbRestoreStreamWithHash(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  hashCache: HashCacheMap,
  signal?: AbortSignal,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const cachedCount = Object.keys(hashCache).length;
  const lastMessageId = resolveLatestMessageId(hashCache, conversationModel.loadLastMessageId(conversationId));
  const diff = computeHashDiff(hashCache, request.messages, cachedCount, lastMessageId);

  const newToolsHash = hashTools(request.tools as unknown[] | undefined);
  const existingToolsHash = conversationModel.loadToolsHash(conversationId);
  const toolsChanged = newToolsHash !== null && newToolsHash !== existingToolsHash;
  const finalToolsHash = toolsChanged ? newToolsHash : existingToolsHash;

  // Full match: regenerate
  if (diff.isFullMatch) {
    const { ctx, account } = await restoreSessionContext(providerName, conversationId, lastMessageId);

    if (!hasPendingInput(request.messages)) {
      console.log(
        `[CONV] DB full hash match for ${conversationId}, no pending user/tool input ` +
          `(lastRole=${lastNonSystemRole(request.messages) ?? '<none>'}) - skipping provider call`,
      );
      if (toolsChanged) {
        conversationModel.saveHashCache(
          conversationId,
          account.itemId,
          providerName,
          hashCache,
          finalToolsHash,
          lastMessageId,
        );
      }
      return { stream: emptyStream(), accountId: account.itemId, conversationId };
    }

    const entry = getSession(conversationId);
    const lastReqId = entry?.lastRequestMessageId;
    if (lastReqId) {
      console.log(`[CONV] DB full hash match for ${conversationId}, regenerating via edit_message id=${lastReqId}`);
    } else {
      console.log(`[CONV] DB full hash match for ${conversationId}, regenerating (no edit id, full regenerate)`);
    }
    ctx.metadata.parentMessageId = undefined;
    ctx.metadata.editMessageId = lastReqId ?? undefined;
    ctx.metadata.toolsChanged = toolsChanged;
    attachCachedImageSummaries(ctx, hashCache, request.messages);

    const innerStream = provider.chatStream(ctx, request, signal);

    async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
      let saved = false;
      let lastMsgSaved = false;
      try {
        for await (const chunk of innerStream) {
          if (signal?.aborted) return;
          if (!saved) {
            saved = true;
            if (toolsChanged) {
              conversationModel.saveHashCache(
                conversationId,
                account.itemId,
                providerName,
                hashCache,
                finalToolsHash,
                lastMessageId,
              );
            }
            if (ctx.metadata.lastResponseMessageId) {
              lastMsgSaved = true;
              updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
              const newLastMessageId = String(ctx.metadata.lastResponseMessageId);
              updateHashCacheParentId(hashCache, request.messages, newLastMessageId);
              conversationModel.saveHashCache(
                conversationId,
                account.itemId,
                providerName,
                hashCache,
                finalToolsHash,
                newLastMessageId,
              );
            }
          }
          if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
            lastMsgSaved = true;
            updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
            const newLastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(hashCache, request.messages, newLastMessageId);
            conversationModel.saveHashCache(
              conversationId,
              account.itemId,
              providerName,
              hashCache,
              finalToolsHash,
              newLastMessageId,
            );
          }
          yield chunk;
        }
      } finally {
        if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
          const newLastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(hashCache, request.messages, newLastMessageId);
          conversationModel.saveHashCache(
            conversationId,
            account.itemId,
            providerName,
            hashCache,
            finalToolsHash,
            newLastMessageId,
          );
        }
        if (ctx.metadata.lastRequestMessageId) {
          updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
        }
      }
    }

    return { stream: wrappedStream(), accountId: account.itemId, conversationId };
  }

  const isRevert = diff.matchedCount < cachedCount;
  console.log(
    `[DIFF] DB hash matched=${diff.matchedCount} cached=${cachedCount} ` +
      `new=${diff.messagesToSend.length} revert=${isRevert}`,
  );

  if (isRevert) {
    pruneHashCache(hashCache, diff.lastMatchedHash);
  }

  // Normal append or revert: restore session, send messagesToSend
  const { ctx, account } = await restoreSessionContext(providerName, conversationId, lastMessageId);
  ctx.metadata.parentMessageId = diff.parentMessageId;
  ctx.metadata.toolsChanged = toolsChanged || isRevert;
  attachCachedImageSummaries(ctx, hashCache, request.messages);

  if (isRevert) {
    const entry = getSession(conversationId);
    const lastReqId = entry?.lastRequestMessageId;
    const editMsgId = diff.matchedCount > 0 ? diff.parentMessageId : undefined;
    ctx.metadata.editMessageId = lastReqId ?? editMsgId ?? undefined;
  }

  const diffRequest: InternalRequest = { ...request, messages: diff.messagesToSend };
  const innerStream = provider.chatStream(ctx, diffRequest, signal);
  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    let saved = false;
    let lastMsgSaved = false;
    try {
      for await (const chunk of innerStream) {
        if (signal?.aborted) return;
        if (!saved) {
          saved = true;
          addRequestToHashCache(hashCache, request.messages, ctx.metadata);
          if (toolsChanged || isRevert) {
            conversationModel.saveHashCache(
              conversationId,
              account.itemId,
              providerName,
              hashCache,
              finalToolsHash,
              lastMessageId,
            );
          }
          conversationCache.set(conversationId, {
            conversationId,
            accountId: account.itemId,
            hashCache,
            toolsHash: finalToolsHash,
            lastMessageId,
          });
          conversationModel.saveHashCache(
            conversationId,
            account.itemId,
            providerName,
            hashCache,
            finalToolsHash,
            lastMessageId,
          );
          if (ctx.metadata.lastResponseMessageId) {
            lastMsgSaved = true;
            updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
            const newLastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(hashCache, request.messages, newLastMessageId);
            conversationCache.set(conversationId, {
              conversationId,
              accountId: account.itemId,
              hashCache,
              toolsHash: finalToolsHash,
              lastMessageId: newLastMessageId,
            });
            conversationModel.saveHashCache(
              conversationId,
              account.itemId,
              providerName,
              hashCache,
              finalToolsHash,
              newLastMessageId,
            );
          }
        }
        if (!lastMsgSaved && ctx.metadata.lastResponseMessageId) {
          lastMsgSaved = true;
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
          const conv = conversationCache.get(conversationId);
          if (conv) {
            conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
            updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
            conversationModel.saveHashCache(
              conversationId,
              account.itemId,
              providerName,
              conv.hashCache,
              finalToolsHash,
              conv.lastMessageId,
            );
          }
        }
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId && !lastMsgSaved) {
        updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
        const conv = conversationCache.get(conversationId);
        if (conv) {
          conv.lastMessageId = String(ctx.metadata.lastResponseMessageId);
          updateHashCacheParentId(conv.hashCache, request.messages, conv.lastMessageId);
          conversationModel.saveHashCache(
            conversationId,
            account.itemId,
            providerName,
            conv.hashCache,
            finalToolsHash,
            conv.lastMessageId,
          );
        }
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
      }
      if (!saved) {
        const savedLastMessageId = ctx.metadata.lastResponseMessageId
          ? String(ctx.metadata.lastResponseMessageId)
          : lastMessageId;
        addRequestToHashCache(hashCache, request.messages, ctx.metadata);
        if (savedLastMessageId !== null) {
          updateHashCacheParentId(hashCache, request.messages, savedLastMessageId);
        }
        conversationCache.set(conversationId, {
          conversationId,
          accountId: account.itemId,
          hashCache,
          toolsHash: finalToolsHash,
          lastMessageId: savedLastMessageId,
        });
        conversationModel.saveHashCache(
          conversationId,
          account.itemId,
          providerName,
          hashCache,
          finalToolsHash,
          savedLastMessageId,
        );
      }
    }
  }

  return { stream: wrappedStream(), accountId: account.itemId, conversationId };
}

// --- Hash Helpers ---

function resolveLatestMessageId(hashCache: HashCacheMap, storedLastMessageId: string | null): string | null {
  let latest = storedLastMessageId;
  for (const entry of Object.values(hashCache)) {
    if (entry.parent_message_id !== null && (latest === null || entry.parent_message_id.localeCompare(latest) > 0)) {
      latest = entry.parent_message_id;
    }
  }
  if (latest !== storedLastMessageId) {
    console.log(
      `[DIFF] Stored last_message_id=${storedLastMessageId ?? '<none>'} is stale; ` +
        `using latest hash parent_message_id=${latest}`,
    );
  }
  return latest;
}

function computeHashDiff(
  hashCache: HashCacheMap,
  requestMessages: InternalMessage[],
  cachedCount: number,
  lastMessageId: string | null,
): {
  messagesToSend: InternalMessage[];
  parentMessageId: string | null;
  lastMatchedHash: string | null;
  isFullMatch: boolean;
  matchedCount: number;
} {
  const tracked = filterTrackedMessages(requestMessages);
  let matchedCount = 0;
  let lastMatchedHash: string | null = null;

  console.log(
    `[DIFF] computeHashDiff: tracked=${tracked.length} cached=${cachedCount} lastMsgId=${lastMessageId} ` +
      `roles=[${tracked.map((m) => m.role).join(',')}]`,
  );

  for (let i = 0; i < tracked.length; i++) {
    const h = hashMessage(tracked[i]);
    const entry = hashCache[h];
    if (entry !== undefined) {
      matchedCount++;
      lastMatchedHash = h;
    } else {
      console.log(
        `[DIFF] FIRST_MISMATCH at idx=${i}/${tracked.length} role=${tracked[i].role} ` +
          `hash=${h.slice(0, 12)}... content_preview=${String(tracked[i].content).slice(0, 120).replace(/\n/g, '\\n')}`,
      );
      break;
    }
  }

  if (matchedCount === tracked.length) {
    // Trường hợp có messages mới nhưng hash trùng với entries cũ
    // (matchedCount > cachedCount): đây là normal append, không phải full match.
    // Nếu dùng edit_message sẽ bỏ qua tool results → infinite loop.
    if (matchedCount > cachedCount) {
      console.log(
        `[DIFF] APPEND_WITH_DUP_HASH tracked=${tracked.length} > cached=${cachedCount} ` +
          `matched=${matchedCount} — sending as new messages`,
      );
      const firstNewTracked = tracked[cachedCount];
      const originalIndex = requestMessages.indexOf(firstNewTracked);
      const messagesToSend = requestMessages.slice(originalIndex >= 0 ? originalIndex : 0);
      const parentMessageId =
        lastMessageId ?? (lastMatchedHash ? (hashCache[lastMatchedHash]?.parent_message_id ?? null) : null);
      console.log(
        `[DIFF] RESULT: APPEND_DUP matched=${matchedCount}/${tracked.length} cached=${cachedCount} ` +
          `parentMsgId=${parentMessageId} msgsToSend=${messagesToSend.length} roles=[${messagesToSend.map((m: InternalMessage) => m.role).join(',')}]`,
      );
      return { messagesToSend, parentMessageId, lastMatchedHash, isFullMatch: false, matchedCount };
    }

    console.log(
      `[DIFF] FULL_MATCH tracked=${tracked.length} cached=${cachedCount} ` + `lastMessageId=${lastMessageId}`,
    );
    const parentMessageId =
      lastMessageId ?? (lastMatchedHash ? (hashCache[lastMatchedHash]?.parent_message_id ?? null) : null);
    console.log(`[DIFF] RESULT: FULL_MATCH parentMsgId=${parentMessageId} — editing via edit_message`);
    return { messagesToSend: [], parentMessageId, lastMatchedHash, isFullMatch: true, matchedCount };
  }

  // Serial chain: from first non-matching tracked message, bundle all original messages after it
  const firstNewTracked = tracked[matchedCount];
  const originalIndex = requestMessages.indexOf(firstNewTracked);
  const messagesToSend = requestMessages.slice(originalIndex >= 0 ? originalIndex : 0);

  // Normal append (matchedCount === cachedCount): use lastMessageId
  // Revert (matchedCount < cachedCount): use hash entry's parent_message_id
  const isRevert = matchedCount < cachedCount;
  const parentMessageId = isRevert
    ? lastMatchedHash
      ? (hashCache[lastMatchedHash]?.parent_message_id ?? null)
      : null
    : (lastMessageId ?? (lastMatchedHash ? (hashCache[lastMatchedHash]?.parent_message_id ?? null) : null));

  console.log(
    `[DIFF] RESULT: matched=${matchedCount}/${tracked.length} cached=${cachedCount} ` +
      `revert=${isRevert} parentMsgId=${parentMessageId} ` +
      `msgsToSend=${messagesToSend.length} roles=[${messagesToSend.map((m: InternalMessage) => m.role).join(',')}]`,
  );

  return { messagesToSend, parentMessageId, lastMatchedHash, isFullMatch: false, matchedCount };
}

function hasPendingInput(messages: InternalMessage[]): boolean {
  const role = lastNonSystemRole(messages);
  return role === 'user' || role === 'tool';
}

function lastNonSystemRole(messages: InternalMessage[]): InternalMessage['role'] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'system') return messages[i].role;
  }
  return null;
}

function pruneHashCache(hashCache: HashCacheMap, lastMatchedHash: string | null): void {
  if (!lastMatchedHash) {
    // No matched entries, clear everything
    for (const key of Object.keys(hashCache)) delete hashCache[key];
    return;
  }
  const anchor = hashCache[lastMatchedHash];
  if (!anchor) return;
  for (const key of Object.keys(hashCache)) {
    if (hashCache[key].request_message_id > anchor.request_message_id) {
      delete hashCache[key];
    }
  }
}

function addRequestToHashCache(
  hashCache: HashCacheMap,
  requestMessages: InternalMessage[],
  metadata: Record<string, unknown>,
): void {
  const tracked = filterTrackedMessages(requestMessages);
  const parentMessageId = metadata.lastResponseMessageId ? String(metadata.lastResponseMessageId) : null;
  const requestMessageId = metadata.lastRequestMessageId ? String(metadata.lastRequestMessageId) : '';
  const imageSummaries = new Map(
    (
      (metadata.imageSummaries as Array<{ messageHash: string; summary: string; imageCount: number }> | undefined) ?? []
    ).map((item) => [item.messageHash, item]),
  );

  for (const msg of tracked) {
    const h = hashMessage(msg);
    if (!hashCache[h]) {
      hashCache[h] = { parent_message_id: parentMessageId, request_message_id: requestMessageId };
    }
    const imageSummary = imageSummaries.get(h);
    if (imageSummary) {
      hashCache[h].image_summary = imageSummary.summary;
      hashCache[h].image_count = imageSummary.imageCount;
    }
  }
}

function attachCachedImageSummaries(
  ctx: SessionContext,
  hashCache: HashCacheMap,
  requestMessages: InternalMessage[],
): void {
  const summaries: Array<{ messageHash: string; summary: string; imageCount: number }> = [];
  const seen = new Set<string>();

  for (const msg of filterTrackedMessages(requestMessages)) {
    const h = hashMessage(msg);
    if (seen.has(h)) continue;
    seen.add(h);

    const entry = hashCache[h];
    if (entry?.image_summary) {
      summaries.push({
        messageHash: h,
        summary: entry.image_summary,
        imageCount: entry.image_count ?? 0,
      });
    }
  }

  if (summaries.length > 0) {
    ctx.metadata.cachedImageSummaries = summaries;
    console.log(`[CONV] attached cached image summaries=${summaries.length}`);
  }
}

function buildHashCacheFromRequest(request: InternalRequest, metadata: Record<string, unknown>): HashCacheMap {
  const hashCache: HashCacheMap = {};
  addRequestToHashCache(hashCache, request.messages, metadata);
  return hashCache;
}

function buildHashCacheFromMessages(messages: InternalMessage[]): HashCacheMap {
  const hashCache: HashCacheMap = {};
  const tracked = filterTrackedMessages(messages);
  for (const msg of tracked) {
    const h = hashMessage(msg);
    if (!hashCache[h]) {
      hashCache[h] = { parent_message_id: null, request_message_id: '' };
    }
  }
  return hashCache;
}
