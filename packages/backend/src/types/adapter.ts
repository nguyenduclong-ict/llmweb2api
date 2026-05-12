import type { Request } from 'express';
import type { InternalRequest, InternalResponse, InternalStreamChunk } from './common';

export interface Adapter {
  readonly name: string;
  parseRequest(req: Request): InternalRequest;
  formatResponse(internal: InternalResponse): unknown;
  formatStreamChunk(chunk: InternalStreamChunk): string;
}
