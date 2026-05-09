import type { InternalRequest, InternalResponse, InternalStreamChunk } from './common';

export interface SessionContext {
  accountId: number;
  token: string;
  sessionId: string;
  powResponse?: string;
  metadata: Record<string, unknown>;
}

export interface Provider {
  readonly name: string;
  login(settings: Record<string, unknown>): Promise<SessionContext>;
  createSession(ctx: SessionContext): Promise<SessionContext>;
  chat(ctx: SessionContext, request: InternalRequest): Promise<InternalResponse>;
  chatStream(ctx: SessionContext, request: InternalRequest, signal?: AbortSignal): AsyncGenerator<InternalStreamChunk>;
  dispose(ctx: SessionContext): Promise<void>;
  refreshToken?(ctx: SessionContext): Promise<SessionContext>;
}
