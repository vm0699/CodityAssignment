import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env, getMembership, getPool, getProjectById, type OrgRole } from '@pulse/core';
import { ApiError, asyncHandler } from './errors.js';

export interface AuthedRequest extends Request {
  userId: string;
  userEmail: string;
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function signToken(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email }, env('JWT_SECRET'), {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
  } as jwt.SignOptions);
}

export function verifyToken(token: string): { sub: string; email: string } {
  try {
    return jwt.verify(token, env('JWT_SECRET')) as { sub: string; email: string };
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
}

/** Extracts and verifies the Bearer token; attaches userId to the request. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(ApiError.unauthorized());
    return;
  }
  try {
    const claims = verifyToken(header.slice(7));
    (req as AuthedRequest).userId = claims.sub;
    (req as AuthedRequest).userEmail = claims.email;
    next();
  } catch (err) {
    next(err);
  }
}

/** Asserts the user has at least `minRole` in the given org. Returns the role. */
export async function assertOrgRole(userId: string, orgId: string, minRole: OrgRole): Promise<OrgRole> {
  const membership = await getMembership(getPool(), orgId, userId);
  if (!membership) throw ApiError.notFound('Organization');
  if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
    throw ApiError.forbidden(`This action requires the '${minRole}' role (you have '${membership.role}')`);
  }
  return membership.role;
}

/** Project-scoped RBAC: resolves the project's org and checks the role there. */
export async function assertProjectRole(userId: string, projectId: string, minRole: OrgRole) {
  const project = await getProjectById(getPool(), projectId);
  if (!project) throw ApiError.notFound('Project');
  await assertOrgRole(userId, project.org_id, minRole);
  return project;
}

/** Convenience middleware factory for routes with :projectId params. */
export function requireProjectRole(minRole: OrgRole) {
  return asyncHandler<AuthedRequest>(async (req, _res, next) => {
    await assertProjectRole(req.userId, req.params.projectId, minRole);
    next();
  });
}
