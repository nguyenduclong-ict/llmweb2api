import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth';
import { loggerMiddleware } from '../middleware/logger';
import { rateLimitMiddleware } from '../middleware/rateLimit';
import { openaiAdapter, sseEvent } from '../../adapters/openai';
import { openaiResponsesAdapter } from '../../adapters/openai/responses';
import { anthropicAdapter } from '../../adapters/anthropic';
import { geminiAdapter } from '../../adapters/gemini';
import { processChat, processChatStream } from '../../providers/core/manager';
import type { ToolCall } from '../../types/common';

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

function dumpRawChatRequest(req: Request): void {
  if (process.env.LLMWEB2API_DUMP_RAW_REQUESTS === '0') return;

  try {
    const outDir = path.resolve(__dirname, '../../../data/debug');
    fs.mkdirSync(outDir, { recursive: true });

    const entry = req.body;

    const outFile = path.join(outDir, 'chat-completions-raw.jsonl');
    fs.appendFileSync(outFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[RAW_DUMP] Failed to write chat request dump:', (err as Error).message);
  }
}

apiRoutes.post('/v1/chat/completions', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = openaiAdapter.parseRequest(req.body);
    dumpRawChatRequest(req);
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
        const { stream, accountId, conversationId } = await processChatStream(
          internalReq.providerName,
          internalReq,
          useCache,
          controller.signal,
        );

        (req as any).accountId = accountId;

        let firstChunk = true;
        for await (const chunk of stream) {
          if (firstChunk && conversationId) {
            chunk.conversationId = conversationId;
          }
          const sseData = openaiAdapter.formatStreamChunk(chunk);
          if (firstChunk) {
            console.log(
              `[SSE] FIRST chunk convId=${conversationId} chunk.conversationId=${(chunk as any).conversationId} data=${sseData.slice(0, 300)}`,
            );
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

    const { response, accountId } = await processChat(internalReq.providerName, internalReq, useCache);

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

apiRoutes.post('/v1/responses', apiPipeline, async (req: Request, res: Response) => {
  try {
    const internalReq = openaiResponsesAdapter.parseRequest(req.body);
    dumpRawChatRequest(req);
    const useCache: boolean = !!(req as any).apiKeyCache;

    if (req.body.stream) {
      const controller = new AbortController();
      res.on('close', () => {
        controller.abort();
        console.log('[SSE] Client disconnected, aborting responses stream');
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const { stream, accountId, conversationId } = await processChatStream(
          internalReq.providerName,
          internalReq,
          useCache,
          controller.signal,
        );

        (req as any).accountId = accountId;

        const responseId = `resp_${Date.now()}`;
        let firstChunk = true;
        let outputText = '';
        let reasoningText = '';
        let lastChunk;
        let toolCallOutputIndex = 1;
        const streamedToolCalls = new Map<number, ToolCall>();
        const emittedOutputItems = new Set<number>();
        let reasoningItemEmitted = false;
        let messageItemEmitted = false;
        safeWrite(res, openaiResponsesAdapter.formatStreamStart(responseId, internalReq.model));

        for await (const chunk of stream) {
          if (firstChunk && conversationId) {
            chunk.conversationId = conversationId;
            console.log(`[SSE-RESPONSES] set chunk.conversationId=${conversationId}`);
          }
          firstChunk = false;
          lastChunk = chunk;
          if (chunk.content) outputText += chunk.content;
          if (chunk.reasoningContent) {
            reasoningText += chunk.reasoningContent;
            if (!reasoningItemEmitted) {
              safeWrite(
                res,
                sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { id: `rs_${responseId}`, type: 'reasoning', status: 'in_progress', content: [] },
                }),
              );
              safeWrite(
                res,
                sseEvent('response.content_part.added', {
                  type: 'response.content_part.added',
                  item_id: `rs_${responseId}`,
                  output_index: 0,
                  content_index: 0,
                  part: { type: 'reasoning_text', text: '' },
                }),
              );
              reasoningItemEmitted = true;
            }
          }
          if (chunk.content && !messageItemEmitted) {
            if (reasoningItemEmitted) {
              safeWrite(
                res,
                sseEvent('response.content_part.done', {
                  type: 'response.content_part.done',
                  item_id: `rs_${responseId}`,
                  output_index: 0,
                  content_index: 0,
                  part: {
                    type: 'reasoning_text',
                    text: reasoningText.replace(/\n?#conversation_id=[a-zA-Z0-9-_]+/, '').trim(),
                  },
                }),
              );
              safeWrite(
                res,
                sseEvent('response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: 0,
                  item: {
                    id: `rs_${responseId}`,
                    type: 'reasoning',
                    status: 'completed',
                    content: [
                      {
                        type: 'reasoning_text',
                        text: reasoningText.replace(/\n?#conversation_id=[a-zA-Z0-9-_]+/, '').trim(),
                      },
                    ],
                  },
                }),
              );
            }
            const msgOutputIndex = reasoningItemEmitted ? 1 : 0;
            safeWrite(
              res,
              sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: msgOutputIndex,
                item: {
                  id: `msg_${responseId}`,
                  type: 'message',
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              }),
            );
            safeWrite(
              res,
              sseEvent('response.content_part.added', {
                type: 'response.content_part.added',
                item_id: `msg_${responseId}`,
                output_index: msgOutputIndex,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              }),
            );
            messageItemEmitted = true;
          }
          if (chunk.toolCalls) {
            chunk.toolCalls.forEach((toolCall, index) => streamedToolCalls.set(index, toolCall));
          }
          if (chunk.toolCallDelta) {
            const index = chunk.toolCallDelta.index;
            const isNew = !streamedToolCalls.has(index);
            const existing =
              streamedToolCalls.get(index) ??
              ({
                id: chunk.toolCallDelta.id ?? `call_${index + 1}`,
                type: 'function',
                function: { name: '', arguments: '' },
              } satisfies ToolCall);

            if (chunk.toolCallDelta.id) existing.id = chunk.toolCallDelta.id;
            if (chunk.toolCallDelta.function?.name) existing.function.name += chunk.toolCallDelta.function.name;
            if (chunk.toolCallDelta.function?.arguments) {
              existing.function.arguments += chunk.toolCallDelta.function.arguments;
            }
            streamedToolCalls.set(index, existing);

            if (isNew && existing.id) {
              const oi = toolCallOutputIndex++;
              safeWrite(
                res,
                openaiResponsesAdapter.formatOutputItemAdded(oi, {
                  id: existing.id,
                  type: 'function_call',
                  status: 'in_progress',
                  call_id: existing.id,
                  name: existing.function.name || '',
                  arguments: '',
                }),
              );
              emittedOutputItems.add(index);
            }

            if (chunk.toolCallDelta.function?.arguments) {
              const sseData = openaiResponsesAdapter.formatFunctionCallArgumentsDelta(
                existing.id,
                chunk.toolCallDelta.function.arguments,
              );
              if (sseData && !safeWrite(res, sseData)) break;
            }
          }

          const sseData = openaiResponsesAdapter.formatStreamChunk(chunk, responseId);
          if (sseData && !safeWrite(res, sseData)) break;
        }

        safeWrite(
          res,
          openaiResponsesAdapter.formatStreamDone(
            responseId,
            internalReq.model,
            outputText,
            reasoningText,
            lastChunk,
            [...streamedToolCalls.entries()].sort(([a], [b]) => a - b).map(([, toolCall]) => toolCall),
          ),
        );
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

    const { response, accountId } = await processChat(internalReq.providerName, internalReq, useCache);

    (req as any).accountId = accountId;
    res.json(openaiResponsesAdapter.formatResponse(response));
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
        const { stream, accountId, conversationId } = await processChatStream(
          internalReq.providerName,
          internalReq,
          useCache,
          controller.signal,
        );

        (req as any).accountId = accountId;

        const msgStart: Record<string, unknown> = {
          type: 'message_start',
          message: { id: streamMessageId, type: 'message', role: 'assistant', model: internalReq.model, content: [] },
        };
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

    const { response, accountId } = await processChat(internalReq.providerName, internalReq, useCache);

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
        const { stream, accountId, conversationId } = await processChatStream(
          internalReq.providerName,
          internalReq,
          useCache,
          controller.signal,
        );

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

    const { response, accountId } = await processChat(internalReq.providerName, internalReq, useCache);

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
