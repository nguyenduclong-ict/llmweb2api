import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { loggerMiddleware } from '../middleware/logger';
import { rateLimitMiddleware } from '../middleware/rateLimit';
import { openaiAdapter } from '../../adapters/openai';
import { anthropicAdapter } from '../../adapters/anthropic';
import { geminiAdapter } from '../../adapters/gemini';
import { processChat, processChatStream } from '../../providers/core/manager';

export const apiRoutes: Router = Router();

const apiPipeline = [authMiddleware, loggerMiddleware, rateLimitMiddleware];

function safeWrite(res: Response, data: string): boolean {
  try {
    if (!res.writableEnded) {
      res.write(data);
      return true;
    }
  } catch {
    // Client disconnected
  }
  return false;
}

apiRoutes.post('/v1/chat/completions', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = openaiAdapter.parseRequest(req.body);
    const useCache: boolean = !!(req as any).apiKeyCache;

    if (req.body.stream) {
      const controller = new AbortController();
      res.on('close', () => {
        controller.abort();
        console.log('[SSE] Client disconnected, aborting stream');
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const { stream, accountId, conversationId } = await processChatStream('deepseek', internalReq, useCache, controller.signal);

        (req as any).accountId = accountId;

        let firstChunk = true;
        for await (const chunk of stream) {
          if (firstChunk && conversationId) {
            chunk.conversationId = conversationId;
          }
          const sseData = openaiAdapter.formatStreamChunk(chunk);
          if (firstChunk) {
            console.log(`[SSE] FIRST chunk convId=${conversationId} chunk.conversationId=${(chunk as any).conversationId} data=${sseData.slice(0, 300)}`);
          }
          firstChunk = false;
          if (!safeWrite(res, sseData)) break;
        }
        safeWrite(res, 'data: [DONE]\n\n');
      } catch (err: any) {
        if (err?.message !== 'canceled') {
          console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
        }
        if (!res.headersSent) {
          res.status(500).json({ error: err.message || 'Internal error' });
          return;
        }
      }

      res.end();
      return;
    }

    const { response, accountId } = await processChat('deepseek', internalReq, useCache);

    (req as any).accountId = accountId;
    res.json(openaiAdapter.formatResponse(response));
  } catch (err: any) {
    console.error(
      `[API_ERROR] ${req.method} ${req.originalUrl}:`,
      err?.message || String(err),
      err?.stack?.slice(0, 200) || '',
    );
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

apiRoutes.post('/v1/messages', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = anthropicAdapter.parseRequest(req.body);
    const useCache: boolean = !!(req as any).apiKeyCache;
    if (req.body.stream) {
      const controller = new AbortController();
      res.on('close', () => {
        controller.abort();
        console.log('[SSE] Client disconnected, aborting stream');
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamMessageId = `msg_${Date.now()}`;

      try {
        const { stream, accountId, conversationId } = await processChatStream('deepseek', internalReq, useCache, controller.signal);

        (req as any).accountId = accountId;

        const msgStart: Record<string, unknown> = { type: 'message_start', message: { id: streamMessageId, type: 'message', role: 'assistant', model: internalReq.model, content: [] } };
        if (conversationId) {
          (msgStart as any).conversation_id = conversationId;
          (msgStart.message as any).conversation_id = conversationId;
        }
        safeWrite(res, `event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);

        let firstChunk = true;
        for await (const chunk of stream) {
          if (firstChunk && conversationId) {
            chunk.conversationId = conversationId;
          }
          firstChunk = false;
          if (!safeWrite(res, anthropicAdapter.formatStreamChunk(chunk))) break;
        }
      } catch (err: any) {
        if (err?.message !== 'canceled') {
          console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
        }
        if (!res.headersSent) {
          res.status(500).json({ error: err.message || 'Internal error' });
          return;
        }
      }

      res.end();
      return;
    }

    const { response, accountId } = await processChat('deepseek', internalReq, useCache);

    (req as any).accountId = accountId;
    res.json(anthropicAdapter.formatResponse(response));
  } catch (err: any) {
    console.error(
      `[API_ERROR] ${req.method} ${req.originalUrl}:`,
      err?.message || String(err),
      err?.stack?.slice(0, 200) || '',
    );
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

apiRoutes.post('/v1/models/:modelModel', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = geminiAdapter.parseRequest(req.body);
    const useCache: boolean = !!(req as any).apiKeyCache;
    if (req.body.stream) {
      const controller = new AbortController();
      res.on('close', () => {
        controller.abort();
        console.log('[SSE] Client disconnected, aborting stream');
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const { stream, accountId, conversationId } = await processChatStream('deepseek', internalReq, useCache, controller.signal);

        (req as any).accountId = accountId;

        let firstChunk = true;
        for await (const chunk of stream) {
          if (firstChunk && conversationId) {
            chunk.conversationId = conversationId;
          }
          firstChunk = false;
          if (!safeWrite(res, geminiAdapter.formatStreamChunk(chunk))) break;
        }
      } catch (err: any) {
        if (err?.message !== 'canceled') {
          console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
        }
        if (!res.headersSent) {
          res.status(500).json({ error: err.message || 'Internal error' });
          return;
        }
      }

      res.end();
      return;
    }

    const { response, accountId } = await processChat('deepseek', internalReq, useCache);

    (req as any).accountId = accountId;
    res.json(geminiAdapter.formatResponse(response));
  } catch (err: any) {
    console.error(
      `[API_ERROR] ${req.method} ${req.originalUrl}:`,
      err?.message || String(err),
      err?.stack?.slice(0, 200) || '',
    );
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
