import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prepareAndRun } from '../database';

export function loggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  const startTime = Date.now();

  (req as any).requestId = requestId;
  (req as any).startTime = startTime;

  console.log(`[REQ] ${req.method} ${req.originalUrl} | id=${requestId} | body=${summarizeBody(req.body)}`);

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    console.log(
      `[RES] ${req.method} ${req.originalUrl} | id=${requestId} | status=${res.statusCode} | ${durationMs}ms`,
    );
  });

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    const durationMs = Date.now() - startTime;
    logRequest(req, res, body, durationMs);
    return originalJson(body);
  };

  next();
}

function summarizeBody(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body ?? '').slice(0, 200);
  const b = body as Record<string, unknown>;
  const keys: string[] = [];
  if (b.model) keys.push(`model=${b.model}`);
  if (b.stream) keys.push('stream');
  const msgCount = Array.isArray(b.messages) ? b.messages.length : 0;
  if (msgCount > 0) keys.push(`msgs=${msgCount}`);
  if (b.conversation_id) keys.push(`conv=${(b.conversation_id as string).slice(0, 12)}...`);
  if (b.max_tokens) keys.push(`max_tokens=${b.max_tokens}`);
  return keys.join(' ') || JSON.stringify(b).slice(0, 200);
}

function logRequest(req: Request, res: Response, body: unknown, durationMs: number): void {
  try {
    const endpoint = req.originalUrl;
    const method = req.method;
    const status = res.statusCode;
    const apiKeyId = (req as any).apiKeyId ?? null;
    const accountId = (req as any).accountId ?? null;
    const stream = (req as any).isStream ? 1 : 0;

    const reqBody = JSON.stringify(req.body ?? {});
    const resBody = JSON.stringify(body ?? {});

    let inputTokens = 0;
    let outputTokens = 0;
    if (body && typeof body === 'object') {
      const b = body as any;
      inputTokens = b.usage?.prompt_tokens ?? b.usage?.input_tokens ?? 0;
      outputTokens = b.usage?.completion_tokens ?? b.usage?.output_tokens ?? 0;
    }

    prepareAndRun(
      `INSERT INTO request_logs (id, api_key_id, account_id, endpoint, method, status, stream, input_tokens, output_tokens, request_data, response_data, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        (req as any).requestId,
        apiKeyId,
        accountId,
        endpoint,
        method,
        status,
        stream,
        inputTokens,
        outputTokens,
        reqBody.slice(0, 50000),
        resBody.slice(0, 50000),
        durationMs,
      ],
    );
  } catch (err) {
    console.error('[LOGGER ERROR]', err);
  }
}
