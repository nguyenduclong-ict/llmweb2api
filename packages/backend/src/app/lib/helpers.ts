import { Request } from 'express';

export const getSessionId = (req: Request): string | undefined => {
  /**
   * session_id: codex
   * x-session-affinity: opencode
   */
  return req.get('session_id') || req.get('x-session-affinity') || undefined;
};
