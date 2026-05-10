import { Router, type Request, type Response } from 'express';
import {
  getStatsSummary,
  getRequestVolume,
  getStatusCodeDistribution,
  getEndpointLatency,
  getStatsByModel,
  getDailyTokenStats,
  getKpiStats,
  getRequestStatusTimeline,
} from '../services/statsService';

export const statsRoutes: Router = Router();

// GET /api/stats - Tong quan thong ke
statsRoutes.get('/stats', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  res.json(getStatsSummary(startDate as string, endDate as string));
});

// GET /api/stats/request-volume - Request volume theo thoi gian
statsRoutes.get('/stats/request-volume', (req: Request, res: Response) => {
  const { startDate, endDate, granularity } = req.query;
  const g = granularity === 'day' || granularity === 'week' || granularity === 'month' ? granularity : 'hour';
  res.json(getRequestVolume(startDate as string, endDate as string, g));
});

// GET /api/stats/request-status-timeline - Requests & Errors theo thoi gian
statsRoutes.get('/stats/request-status-timeline', (req: Request, res: Response) => {
  const { startDate, endDate, granularity } = req.query;
  const g = granularity === 'day' || granularity === 'week' || granularity === 'month' ? granularity : 'hour';
  res.json(getRequestStatusTimeline(startDate as string, endDate as string, g));
});

// GET /api/stats/status-codes - Status code distribution
statsRoutes.get('/stats/status-codes', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  res.json(getStatusCodeDistribution(startDate as string, endDate as string));
});

// GET /api/stats/endpoint-latency - Response time theo endpoint
statsRoutes.get('/stats/endpoint-latency', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  res.json(getEndpointLatency(startDate as string, endDate as string));
});

// GET /api/stats/by-model - Thong ke theo model
statsRoutes.get('/stats/by-model', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  res.json(getStatsByModel(startDate as string, endDate as string));
});

// GET /api/stats/daily-tokens - Token usage theo granularity
statsRoutes.get('/stats/daily-tokens', (req: Request, res: Response) => {
  const { startDate, endDate, granularity } = req.query;
  const g = granularity === 'hour' || granularity === 'week' || granularity === 'month' ? granularity : 'day';
  res.json(getDailyTokenStats(startDate as string, endDate as string, g));
});

// GET /api/stats/kpi - KPI cards
statsRoutes.get('/stats/kpi', (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  res.json(getKpiStats(startDate as string, endDate as string));
});
