import type { Provider, SessionContext } from '../../types/provider';
import type { InternalRequest, InternalResponse, InternalStreamChunk, InternalMessage } from '../../types/common';
import * as accountModel from '../../app/models/account';
import * as conversationModel from '../../app/models/conversation';
import { deleteSession as deleteDeepSeekSession } from '../deepseek/client';

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providerRegistry.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
  return providerRegistry.get(name);
}

// --- Session Reuse (shared by cache & non-cache flows) ---

interface SessionEntry {
  deepseekSessionId: string;
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
  deepseekSessionId: string,
  accountId: number,
  parentMessageId?: string,
): void {
  sessionStore.set(conversationId, { deepseekSessionId, accountId, parentMessageId });
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

export async function processChat(
  providerName: string,
  request: InternalRequest,
  useCache?: boolean,
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  if (useCache) {
    return processChatWithCache(providerName, request, request.conversationId);
  }

  const provider = ensureProvider(providerName);
  const isNew = !request.conversationId;
  const ctx = isNew
    ? await createSession(provider, await selectAccount(providerName))
    : await reuseSession(providerName, request.conversationId!);

  if (isNew) {
    ctx.metadata.conversationId = ctx.sessionId;
    saveSession(ctx.sessionId, ctx.sessionId, ctx.accountId);
  }

  const response = await provider.chat(ctx, request);
  response.conversationId = ctx.sessionId;

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
  }

  return { response, accountId: ctx.accountId, conversationId: ctx.sessionId };
}

export async function processChatStream(
  providerName: string,
  request: InternalRequest,
  useCache?: boolean,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  if (useCache) {
    return processChatStreamWithCache(providerName, request, request.conversationId);
  }

  const provider = ensureProvider(providerName);
  const isNew = !request.conversationId;
  const ctx = isNew
    ? await createSession(provider, await selectAccount(providerName))
    : await reuseSession(providerName, request.conversationId!);

  if (isNew) {
    ctx.metadata.conversationId = ctx.sessionId;
    saveSession(ctx.sessionId, ctx.sessionId, ctx.accountId);
  }

  const innerStream = provider.chatStream(ctx, request);

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
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

  return { stream: wrappedStream(), accountId: ctx.accountId, conversationId: ctx.sessionId };
}

async function reuseSession(providerName: string, conversationId: string): Promise<SessionContext> {
  const entry = getSession(conversationId);
  if (entry) {
    console.log(`[CONV] Reusing session: ${entry.deepseekSessionId}`);
    return buildSessionContext(entry.accountId, entry.deepseekSessionId);
  }

  // Session not in memory — start a brand new conversation
  console.log(`[CONV] ${conversationId} not in sessionStore, starting new conversation`);
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = ctx.sessionId;
  saveSession(ctx.sessionId, ctx.sessionId, ctx.accountId);
  return ctx;
}

// --- Cache-Aware Flow ---

interface CachedConversation {
  conversationId: string;
  accountId: number;
  previousMessages: InternalMessage[];
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
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  if (conversationId) {
    return processCachedChatStream(providerName, request, conversationId);
  }
  return processFirstCachedChatStream(providerName, request);
}

export async function dumpConversation(conversationId: string): Promise<void> {
  conversationCache.delete(conversationId);
  conversationModel.removeConversation(conversationId);

  const entry = sessionStore.get(conversationId);
  if (entry) {
    sessionStore.delete(conversationId);
    try {
      const items = accountModel.getByProvider('deepseek');
      const item = items.find((i) => i.id === entry.accountId);
      if (item) {
        let session: Record<string, unknown>;
        try {
          session = JSON.parse(item.session || '{}');
        } catch {
          session = {};
        }
        const token = (session.token as string) || '';
        if (token) {
          await deleteDeepSeekSession(token, entry.deepseekSessionId);
          console.log(`[CONV] Deleted DeepSeek session ${entry.deepseekSessionId} for ${conversationId}`);
        }
      }
    } catch (err) {
      console.error(`[CONV] Failed to delete DeepSeek session for ${conversationId}:`, err);
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

async function ensureToken(account: AccountSelection): Promise<string> {
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

  const provider = ensureProvider('deepseek');
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
  const token = await ensureToken(account);
  const ctx = await provider.createSession({ accountId: account.itemId, token, sessionId: '', metadata: {} });
  console.log(`[CONV] New conversation created: ${ctx.sessionId}`);
  return ctx;
}

async function createFreshSession(accountId: number, conversationId: string): Promise<SessionContext> {
  const items = accountModel.getByProvider('deepseek');
  const item = items.find((i) => i.id === accountId);
  if (!item) throw new Error(`Account ${accountId} not found`);

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(item.settings);
  } catch {
    settings = {};
  }
  let session: Record<string, unknown>;
  try {
    session = JSON.parse(item.session || '{}');
  } catch {
    session = {};
  }

  const token = await ensureToken({ itemId: item.id, settings, session });
  const provider = ensureProvider('deepseek');
  const ctx = await provider.createSession({ accountId: item.id, token, sessionId: '', metadata: {} });
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, accountId);
  console.log(`[CONV] Fresh session created: ${ctx.sessionId} for conversation ${conversationId}`);
  return ctx;
}

async function buildSessionContext(accountId: number, conversationId: string): Promise<SessionContext> {
  const items = accountModel.getByProvider('deepseek');
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

  const token = await ensureToken({ itemId: item.id, settings, session });
  const entry = getSession(conversationId);
  return {
    accountId,
    token,
    sessionId: conversationId,
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
  saveSession(ctx.sessionId, ctx.sessionId, account.itemId);

  const response = await provider.chat(ctx, request);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
  }

  const messages = [...request.messages];
  conversationCache.set(ctx.sessionId, {
    conversationId: ctx.sessionId,
    accountId: account.itemId,
    previousMessages: messages,
  });
  conversationModel.saveConversation(ctx.sessionId, account.itemId, providerName, messages);

  return {
    response: { ...response, conversationId: ctx.sessionId },
    accountId: account.itemId,
    conversationId: ctx.sessionId,
  };
}

async function processFirstCachedChatStream(
  providerName: string,
  request: InternalRequest,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = ctx.sessionId;
  saveSession(ctx.sessionId, ctx.sessionId, account.itemId);

  const innerStream = provider.chatStream(ctx, request);

  const messages = [...request.messages];

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId) {
        updateSessionParent(ctx.sessionId, ctx.metadata.lastResponseMessageId as string);
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(ctx.sessionId, ctx.metadata.lastRequestMessageId as string);
      }
      conversationCache.set(ctx.sessionId, {
        conversationId: ctx.sessionId,
        accountId: account.itemId,
        previousMessages: messages,
      });
      conversationModel.saveConversation(ctx.sessionId, account.itemId, providerName, messages);
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
    const dbMessages = conversationModel.loadMessages(conversationId);
    if (!dbMessages || dbMessages.length === 0) {
      console.log(`[CONV] ${conversationId} not found in cache or DB, starting new cached conversation`);
      return processFirstCachedChat(providerName, request);
    }
    return handleDbRestoreChat(providerName, request, conversationId, dbMessages);
  }

  const { diffMessages, divergedAt } = computeDiff(cached.previousMessages, request.messages);

  // Same messages → regenerate
  if (diffMessages.length === 0) {
    console.log(`[CONV] No new messages for ${conversationId}, regenerating...`);
    const provider = ensureProvider(providerName);
    const ctx = await buildSessionContext(cached.accountId, conversationId);
    ctx.metadata.parentMessageId = undefined;
    ctx.metadata.conversationId = conversationId;

    const response = await provider.chat(ctx, request);

    if (ctx.metadata.lastResponseMessageId) {
      updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
    }

    return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
  }

  const provider = ensureProvider(providerName);

  // Branch detected: client removed cached messages, create new session
  if (divergedAt < cached.previousMessages.length) {
    console.log(`[CONV] Branch at index ${divergedAt}, creating new session for ${conversationId}`);
    const ctx = await createFreshSession(cached.accountId, conversationId);

    const response = await provider.chat(ctx, request);

    if (ctx.metadata.lastResponseMessageId) {
      updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
    }
    if (ctx.metadata.lastRequestMessageId) {
      updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
    }

    const messages = [...request.messages];
    conversationCache.set(conversationId, { conversationId, accountId: cached.accountId, previousMessages: messages });
    conversationModel.saveConversation(conversationId, cached.accountId, providerName, messages);

    return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
  }

  // Normal append
  const ctx = await buildSessionContext(cached.accountId, conversationId);
  const diffRequest: InternalRequest = { ...request, messages: diffMessages };
  const response = await provider.chat(ctx, diffRequest);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
  }

  cached.previousMessages = [...request.messages];
  conversationModel.saveConversation(conversationId, cached.accountId, providerName, cached.previousMessages);

  return { response: { ...response, conversationId }, accountId: cached.accountId, conversationId };
}

async function processCachedChatStream(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const cached = conversationCache.get(conversationId);

  if (!cached) {
    const dbMessages = conversationModel.loadMessages(conversationId);
    if (!dbMessages || dbMessages.length === 0) {
      console.log(`[CONV] ${conversationId} not found in cache or DB, starting new cached stream`);
      return processFirstCachedChatStream(providerName, request);
    }
    return handleDbRestoreChatStream(providerName, request, conversationId, dbMessages);
  }

  const { diffMessages, divergedAt } = computeDiff(cached.previousMessages, request.messages);

  // Same messages → regenerate via edit_message
  if (diffMessages.length === 0) {
    const entry = getSession(conversationId);
    const lastReqId = entry?.lastRequestMessageId;
    if (lastReqId) {
      console.log(`[CONV] No new messages for ${conversationId}, regenerating via edit_message id=${lastReqId}`);
    } else {
      console.log(`[CONV] No new messages for ${conversationId}, regenerating (no edit id, full regenerate)`);
    }
    const provider = ensureProvider(providerName);
    const ctx = await buildSessionContext(cached.accountId, conversationId);
    ctx.metadata.editMessageId = lastReqId ? Number(lastReqId) : undefined;
    ctx.metadata.conversationId = conversationId;

    const innerStream = provider.chatStream(ctx, request);

    async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
      try {
        for await (const chunk of innerStream) {
          yield chunk;
        }
      } finally {
        if (ctx.metadata.lastResponseMessageId) {
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
        }
      }
    }

    return { stream: wrappedStream(), accountId: cached.accountId, conversationId };
  }

  const provider = ensureProvider(providerName);

  // Branch detected: client removed some cached messages, need new session
  if (divergedAt < cached.previousMessages.length) {
    console.log(`[CONV] Branch at index ${divergedAt}, creating new session for ${conversationId}`);
    const conv2 = cached;
    const ctx = await createFreshSession(conv2.accountId, conversationId);

    const innerStream = provider.chatStream(ctx, request);
    const messages = [...request.messages];

    async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
      try {
        for await (const chunk of innerStream) {
          yield chunk;
        }
      } finally {
        if (ctx.metadata.lastResponseMessageId) {
          updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
        }
        if (ctx.metadata.lastRequestMessageId) {
          updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
        }
        conversationCache.set(conversationId, {
          conversationId,
          accountId: conv2.accountId,
          previousMessages: messages,
        });
        conversationModel.saveConversation(conversationId, conv2.accountId, providerName, messages);
      }
    }

    return { stream: wrappedStream(), accountId: conv2.accountId, conversationId };
  }

  // Normal append
  const conv = cached;
  const ctx = await buildSessionContext(conv.accountId, conversationId);
  const diffRequest: InternalRequest = { ...request, messages: diffMessages };
  const innerStream = provider.chatStream(ctx, diffRequest);

  const messages = [...request.messages];

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId) {
        updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
      }
      conversationCache.set(conversationId, {
        conversationId,
        accountId: conv.accountId,
        previousMessages: messages,
      });
      conversationModel.saveConversation(conversationId, conv.accountId, providerName, messages);
    }
  }

  return { stream: wrappedStream(), accountId: conv.accountId, conversationId };
}

// --- DB Restore (after server restart) ---

async function handleDbRestoreChat(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  _dbMessages: InternalMessage[],
): Promise<{ response: InternalResponse; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, account.itemId);

  const response = await provider.chat(ctx, request);

  if (ctx.metadata.lastResponseMessageId) {
    updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
  }

  const messages = [...request.messages];
  conversationCache.set(conversationId, { conversationId, accountId: account.itemId, previousMessages: messages });
  conversationModel.saveConversation(conversationId, account.itemId, providerName, messages);

  return { response: { ...response, conversationId }, accountId: account.itemId, conversationId };
}

async function handleDbRestoreChatStream(
  providerName: string,
  request: InternalRequest,
  conversationId: string,
  _dbMessages: InternalMessage[],
): Promise<{ stream: AsyncGenerator<InternalStreamChunk>; accountId: number; conversationId: string }> {
  const provider = ensureProvider(providerName);
  const account = await selectAccount(providerName);
  const ctx = await createSession(provider, account);
  ctx.metadata.conversationId = conversationId;
  saveSession(conversationId, ctx.sessionId, account.itemId);

  const innerStream = provider.chatStream(ctx, request);

  async function* wrappedStream(): AsyncGenerator<InternalStreamChunk> {
    try {
      for await (const chunk of innerStream) {
        yield chunk;
      }
    } finally {
      if (ctx.metadata.lastResponseMessageId) {
        updateSessionParent(conversationId, ctx.metadata.lastResponseMessageId as string);
      }
      if (ctx.metadata.lastRequestMessageId) {
        updateSessionLastRequestId(conversationId, ctx.metadata.lastRequestMessageId as string);
      }
    }
  }

  const messages = [...request.messages];
  conversationCache.set(conversationId, { conversationId, accountId: account.itemId, previousMessages: messages });
  conversationModel.saveConversation(conversationId, account.itemId, providerName, messages);

  return { stream: wrappedStream(), accountId: account.itemId, conversationId };
}

// --- Helpers ---

interface DiffResult {
  diffMessages: InternalMessage[];
  divergedAt: number;
}

function computeDiff(previous: InternalMessage[], current: InternalMessage[]): DiffResult {
  if (previous.length === 0) return { diffMessages: current, divergedAt: 0 };

  let divergeIdx = 0;
  while (
    divergeIdx < previous.length &&
    divergeIdx < current.length &&
    msgEquals(previous[divergeIdx], current[divergeIdx])
  ) {
    divergeIdx++;
  }

  return { diffMessages: current.slice(divergeIdx), divergedAt: divergeIdx };
}

function msgEquals(a: InternalMessage, b: InternalMessage): boolean {
  if (a.role !== b.role) return false;
  const aContent = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
  const bContent = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
  return aContent === bContent;
}
