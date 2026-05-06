import type { Request, Response, NextFunction } from 'express';

// Stub: rate limit logic to be implemented in later phases
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  next();
}
