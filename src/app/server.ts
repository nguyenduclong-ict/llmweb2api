import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { apiRoutes } from './routes/api';
import { managementRoutes } from './routes/management';
import { statsRoutes } from './routes/stats';
import { pruneOldConversations } from './models/conversation';
import { deleteOldLogs } from './models/log';
import { getSetting } from './services/settingsService';

function startCleanupTimer(): void {
  setInterval(
    () => {
      try {
        const retention = getSetting('conversation_retention', '');
        if (retention === 'immediate') {
          const deleted = pruneOldConversations(0);
          if (deleted > 0) console.log(`[cleanup] Pruned ${deleted} conversations (immediate)`);
        } else if (retention === '1h') {
          const deleted = pruneOldConversations(1);
          if (deleted > 0) console.log(`[cleanup] Pruned ${deleted} conversations (1h)`);
        } else if (retention === '24h') {
          const deleted = pruneOldConversations(24);
          if (deleted > 0) console.log(`[cleanup] Pruned ${deleted} conversations (24h)`);
        }

        const logRetention = getSetting('log_retention_days', '');
        if (logRetention) {
          const days = parseInt(logRetention, 10);
          if (days > 0) {
            const deleted = deleteOldLogs(days);
            if (deleted > 0) console.log(`[cleanup] Deleted ${deleted} old logs (>${days} days)`);
          }
        }
      } catch (err) {
        console.error('[cleanup] Error:', (err as Error).message);
      }
    },
    5 * 60 * 1000,
  );
}

export function createServer(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use(apiRoutes);
  app.use('/api', managementRoutes);
  app.use('/api', statsRoutes);

  startCleanupTimer();

  const uiDistPath = path.resolve(__dirname, '..', 'ui');
  const indexPath = path.join(uiDistPath, 'index.html');

  if (fs.existsSync(indexPath)) {
    app.use(express.static(uiDistPath, { maxAge: '7d' }));
    app.get('*', (_req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const reqId = (req as any).requestId || 'no-id';
    console.error(`[ERROR] id=${reqId} ${req.method} ${req.originalUrl} | ${err.message}`);
    if (err.stack) {
      console.error(`[ERROR] id=${reqId} stack: ${err.stack.slice(0, 500)}`);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}
