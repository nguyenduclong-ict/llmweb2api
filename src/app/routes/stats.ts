import { Router, type Request, type Response } from 'express';
import { getStatsSummary } from '../services/statsService';

export const statsRoutes: Router = Router();

statsRoutes.get('/stats', (_req: Request, res: Response) => {
  const { startDate, endDate } = _req.query;
  res.json(getStatsSummary(startDate as string, endDate as string));
});
