import type { Provider, SessionContext } from '../../types/provider';
import type { InternalRequest, InternalResponse, InternalStreamChunk } from '../../types/common';

class ChatGPTProvider implements Provider {
  readonly name = 'chatgpt';

  async login(_settings: Record<string, unknown>): Promise<SessionContext> {
    throw new Error('ChatGPT provider not implemented yet');
  }

  async createSession(ctx: SessionContext): Promise<SessionContext> {
    return ctx;
  }

  async chat(_ctx: SessionContext, _request: InternalRequest): Promise<InternalResponse> {
    throw new Error('ChatGPT provider not implemented yet');
  }

  // eslint-disable-next-line require-yield
  async *chatStream(_ctx: SessionContext, _request: InternalRequest): AsyncGenerator<InternalStreamChunk> {
    throw new Error('ChatGPT streaming not implemented yet');
  }

  async dispose(_ctx: SessionContext): Promise<void> {
    // TODO: Phase 2
  }
}

export const chatgptProvider: Provider = new ChatGPTProvider();
