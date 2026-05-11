import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prepareAndRun } from '../database';
import { getSetting } from '../services/settingsService';

const loggedRequests = new Set<string>();

export function loggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  const startTime = Date.now();

  (req as any).requestId = requestId;
  (req as any).startTime = startTime;
  (req as any).responseBody = null;

  const isStream = (req.body as any)?.stream === true;
  (req as any).isStream = isStream;

  const logLevel = getSetting('log_level', 'basic');

  if (logLevel === 'full') {
    console.log(`[REQ] ${req.method} ${req.originalUrl} | id=${requestId} | body=${summarizeBody(req.body)}`);
  }

  // For streaming: intercept res.write() to capture usage from SSE chunks
  let streamInputTokens = 0;
  let streamOutputTokens = 0;
  const originalWrite = res.write.bind(res);

  res.write = function (chunk: unknown): boolean {
    if (isStream && typeof chunk === 'string') {
      // Parse SSE data lines for usage
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:') && line !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.slice(5).trim());
            if (json.usage || json.response?.usage) {
              const usage = json.usage || json.response?.usage;
              streamInputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
              streamOutputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    }
    return originalWrite(chunk as any);
  } as any;

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const logLevel2 = getSetting('log_level', 'basic');
    if (logLevel2 === 'full') {
      console.log(
        `[RES] ${req.method} ${req.originalUrl} | id=${requestId} | status=${res.statusCode} | ${durationMs}ms`,
      );
    }

    if (!loggedRequests.has(requestId)) {
      loggedRequests.add(requestId);
      if (isStream) {
        logStreamRequest(req, res, streamInputTokens, streamOutputTokens, durationMs);
      } else {
        const body = (req as any).responseBody ?? {};
        logRequest(req, res, body, durationMs);
      }
    }
  });

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    (req as any).responseBody = body;
    const durationMs = Date.now() - startTime;
    if (!loggedRequests.has(requestId)) {
      loggedRequests.add(requestId);
      logRequest(req, res, body, durationMs);
    }
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

function logStreamRequest(
  req: Request,
  res: Response,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
): void {
  try {
    const endpoint = req.originalUrl;
    const method = req.method;
    const status = res.statusCode;
    const apiKeyId = (req as any).apiKeyId ?? null;
    const accountId = (req as any).accountId ?? null;

    // Fallback: estimate tokens from request body message text
    if (inputTokens === 0) {
      const reqBody = JSON.stringify(req.body ?? '');
      inputTokens = Math.ceil(reqBody.length / 4);
    }

    const reqBodyStr = JSON.stringify(req.body ?? {});
    const resBodyStr = JSON.stringify({ stream: true, estimated_output_tokens: outputTokens });

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
        1,
        inputTokens,
        outputTokens,
        reqBodyStr.slice(0, 50000),
        resBodyStr.slice(0, 50000),
        durationMs,
      ],
    );
  } catch (err) {
    console.error('[LOGGER ERROR]', err);
  }
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
