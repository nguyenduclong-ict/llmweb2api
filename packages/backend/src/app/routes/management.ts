import { Router, type Request, type Response, type NextFunction } from 'express';

import * as accountModel from '../models/account';
import * as apiKeyModel from '../models/apiKey';
import * as logModel from '../models/log';
import { getSetting, setSetting } from '../services/settingsService';
import { getModelMapJson, getDefaultMaps, getAvailableProviderModels } from '../services/modelService';

export const managementRoutes: Router = Router();

const dashboardAuth = (req: Request, res: Response, next: NextFunction): void => {
  const password = req.headers['x-dashboard-password'] as string;
  const expected = getSetting('dashboard_password') || process.env.DASHBOARD_PASSWORD || 'admin123';
  if (!password || password !== expected) {
    res.status(401).json({ error: 'Invalid dashboard password' });
    return;
  }
  next();
};

// Public: login
managementRoutes.post('/auth/login', (req: Request, res: Response) => {
  const { password } = req.body;
  const expected = getSetting('dashboard_password') || process.env.DASHBOARD_PASSWORD || 'admin123';
  if (!password || password !== expected) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  res.json({ success: true });
});

managementRoutes.get('/auth/verify', (req: Request, res: Response) => {
  res.json({ authenticated: true });
});

// -- Provider Items --
managementRoutes.get('/accounts', dashboardAuth, (_req: Request, res: Response) => {
  res.json(accountModel.getAll());
});

managementRoutes.post('/accounts', dashboardAuth, (req: Request, res: Response) => {
  const { name, provider, settings } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!provider) {
    res.status(400).json({ error: 'provider is required' });
    return;
  }
  res.json(accountModel.create({ name, provider, settings }));
});

managementRoutes.put('/accounts/:id', dashboardAuth, (req: Request, res: Response) => {
  accountModel.update(Number(req.params.id), req.body);
  res.json({ success: true });
});

managementRoutes.delete('/accounts/:id', dashboardAuth, (req: Request, res: Response) => {
  accountModel.remove(Number(req.params.id));
  res.json({ success: true });
});

// -- API Keys --
managementRoutes.get('/api-keys', dashboardAuth, (_req: Request, res: Response) => {
  res.json(apiKeyModel.getAllApiKeys());
});

managementRoutes.post('/api-keys', dashboardAuth, (req: Request, res: Response) => {
  const { name, key, cache } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  res.json(apiKeyModel.createApiKey(name, key, cache));
});

managementRoutes.put('/api-keys/:id', dashboardAuth, (req: Request, res: Response) => {
  apiKeyModel.updateApiKey(Number(req.params.id), req.body);
  res.json({ success: true });
});

managementRoutes.delete('/api-keys/:id', dashboardAuth, (req: Request, res: Response) => {
  apiKeyModel.deleteApiKey(Number(req.params.id));
  res.json({ success: true });
});

// -- Logs --
managementRoutes.get('/logs', dashboardAuth, (req: Request, res: Response) => {
  const { limit, offset, apiKeyId, endpoint, status, startDate, endDate } = req.query;
  res.json(
    logModel.queryLogs({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      apiKeyId: apiKeyId as string,
      endpoint: endpoint as string,
      status: status ? Number(status) : undefined,
      startDate: startDate as string,
      endDate: endDate as string,
    }),
  );
});

// -- Settings --
managementRoutes.get('/settings', dashboardAuth, (_req: Request, res: Response) => {
  res.json({
    dashboardPassword: getSetting('dashboard_password', 'admin123'),
    logRetentionDays: getSetting('log_retention_days', '30'),
    logLevel: getSetting('log_level', 'basic'),
    conversationRetention: getSetting('conversation_retention', ''),
    modelMaps: {
      openai: getModelMapJson('openai'),
      anthropic: getModelMapJson('anthropic'),
      gemini: getModelMapJson('gemini'),
    },
    availableProviderModels: getAvailableProviderModels(),
  });
});

managementRoutes.put('/settings', dashboardAuth, (req: Request, res: Response) => {
  const { dashboardPassword, logRetentionDays, logLevel, conversationRetention } = req.body;
  if (dashboardPassword) setSetting('dashboard_password', dashboardPassword);
  if (logRetentionDays) setSetting('log_retention_days', String(logRetentionDays));
  if (logLevel) setSetting('log_level', logLevel);
  if (conversationRetention !== undefined) setSetting('conversation_retention', String(conversationRetention));
  res.json({ success: true });
});

// -- Model Maps --
managementRoutes.get('/settings/model-maps', dashboardAuth, (_req: Request, res: Response) => {
  res.json({
    openai: getModelMapJson('openai'),
    anthropic: getModelMapJson('anthropic'),
    gemini: getModelMapJson('gemini'),
    availableProviderModels: getAvailableProviderModels(),
    defaults: getDefaultMaps(),
  });
});

managementRoutes.put('/settings/model-maps', dashboardAuth, (req: Request, res: Response) => {
  const { openai, anthropic, gemini } = req.body;
  if (openai) setSetting('model_map_openai', JSON.stringify(openai));
  if (anthropic) setSetting('model_map_anthropic', JSON.stringify(anthropic));
  if (gemini) setSetting('model_map_gemini', JSON.stringify(gemini));
  res.json({ success: true });
});

// -- Config Import/Export --
managementRoutes.get('/settings/export', dashboardAuth, (_req: Request, res: Response) => {
  const items = accountModel.getAll();
  const apiKeys = apiKeyModel.getAllApiKeys();
  res.json({ accounts: items, apiKeys });
});
