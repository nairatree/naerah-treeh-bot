import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config/environment.ts';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const queryKey = req.query.api_key as string;
  const providedKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : queryKey;

  if (!providedKey || providedKey !== config.ADMIN_API_KEY) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid Admin API Key required via Authorization Bearer header or ?api_key query parameter.',
    });
    return;
  }

  next();
}
