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

apiRoutes.post('/v1/chat/completions', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = openaiAdapter.parseRequest(req.body);
    const useCache: boolean = !!(req as any).apiKeyCache;

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const { stream, accountId } = await processChatStream('deepseek', internalReq, useCache);

        (req as any).accountId = accountId;

        for await (const chunk of stream) {
          res.write(openaiAdapter.formatStreamChunk(chunk));
        }
        res.write('data: [DONE]\n\n');
      } catch (err: any) {
        console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
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
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamMessageId = `msg_${Date.now()}`;
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: streamMessageId, type: 'message', role: 'assistant', model: internalReq.model, content: [] } })}\n\n`,
      );

      try {
        const { stream, accountId } = await processChatStream('deepseek', internalReq, useCache);

        (req as any).accountId = accountId;

        for await (const chunk of stream) {
          res.write(anthropicAdapter.formatStreamChunk(chunk));
        }
      } catch (err: any) {
        console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
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
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const { stream, accountId } = await processChatStream('deepseek', internalReq, useCache);

        (req as any).accountId = accountId;

        for await (const chunk of stream) {
          res.write(geminiAdapter.formatStreamChunk(chunk));
        }
      } catch (err: any) {
        console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err.message || String(err));
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
