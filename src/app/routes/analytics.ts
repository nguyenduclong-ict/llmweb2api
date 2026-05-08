import { Router, type Request, type Response } from 'express';
import {
  getAnalyticsKPI,
  getRequestVolume,
  getStatusCodeDistribution,
  getEndpointLatency,
  getRouteTraffic,
  getTokenUsage,
} from '../services/analyticsService';

export const analyticsRoutes: Router = Router();

/** GET /api/analytics — full dashboard payload, optionally filtered by date */
analyticsRoutes.get('/analytics', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

  const kpi = getAnalyticsKPI(startDate, endDate);
  const requestVolume = getRequestVolume(startDate, endDate);
  const statusCodes = getStatusCodeDistribution(startDate, endDate);
  const endpointLatency = getEndpointLatency(startDate, endDate);
  const routeTraffic = getRouteTraffic(startDate, endDate);

  res.json({
    kpi,
    requestVolume,
    statusCodes,
    endpointLatency,
    routeTraffic,
  });
});

/** GET /api/analytics/kpi — only KPI data */
analyticsRoutes.get('/analytics/kpi', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  res.json(getAnalyticsKPI(startDate, endDate));
});

/** GET /api/analytics/token-usage — token usage over time */
analyticsRoutes.get('/analytics/token-usage', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  res.json(getTokenUsage(startDate, endDate));
});
