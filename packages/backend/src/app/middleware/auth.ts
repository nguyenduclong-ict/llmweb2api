import type { Request, Response, NextFunction } from 'express';
import { getApiKeyByKey } from '../models/apiKey';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers.authorization?.replace('Bearer ', '') ?? '';

  if (!apiKey) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  const key = getApiKeyByKey(apiKey);

  if (!key || !key.enabled) {
    res.status(401).json({ error: 'Invalid or disabled API key' });
    return;
  }

  (req as any).apiKeyId = key.id;
  (req as any).apiKeyName = key.name;
  next();
}
