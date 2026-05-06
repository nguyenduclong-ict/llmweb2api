import type { InternalRequest, InternalResponse, InternalStreamChunk } from './common';

export interface Adapter {
  readonly name: string;
  parseRequest(body: unknown): InternalRequest;
  formatResponse(internal: InternalResponse): unknown;
  formatStreamChunk(chunk: InternalStreamChunk): string;
}
