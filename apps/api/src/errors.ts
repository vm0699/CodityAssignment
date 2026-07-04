import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { createLogger, DependencyError } from '@pulse/core';

const log = createLogger({ component: 'api' });

/**
 * Structured error envelope used by every endpoint:
 *   { "error": { "code": "NOT_FOUND", "message": "...", "details"?: [...] } }
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Insufficient permissions') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(resource: string) {
    return new ApiError(404, 'NOT_FOUND', `${resource} not found`);
  }
  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      },
    });
    return;
  }
  if (err instanceof DependencyError) {
    res.status(422).json({ error: { code: 'DEPENDENCY_ERROR', message: err.message } });
    return;
  }
  // Postgres unique violations surface as friendly conflicts.
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A resource with that identifier already exists' } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', { method: req.method, path: req.path, error: message });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

/** Wraps async route handlers so rejections reach the error middleware. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}
