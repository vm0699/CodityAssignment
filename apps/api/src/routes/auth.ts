import bcrypt from 'bcryptjs';
import { Router } from 'express';
import {
  createLogger,
  createOrganization,
  createUser,
  findUserByEmail,
  findUserById,
  getPool,
  listOrganizationsForUser,
  listProjectsForUser,
  provisionStarterWorkspace,
} from '@pulse/core';
import { requireAuth, signToken, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { loginSchema, registerSchema } from '../validate.js';

const log = createLogger({ component: 'auth' });

export const authRouter = Router();

/**
 * Backstop for accounts that predate the auto-provisioning feature (or hit
 * some earlier failure during registration): if a user has an organization
 * but zero projects anywhere, provision the starter workspace now instead of
 * leaving them on an empty dashboard forever. Cheap to call on every
 * login/me request — it's a no-op the moment any project exists.
 */
async function ensureStarterWorkspace(userId: string): Promise<void> {
  try {
    const pool = getPool();
    const [orgs, projects] = await Promise.all([
      listOrganizationsForUser(pool, userId),
      listProjectsForUser(pool, userId),
    ]);
    if (orgs.length === 0 || projects.length > 0) return;
    await provisionStarterWorkspace(pool, { orgId: orgs[0].id, userId });
  } catch (err) {
    log.error('failed to backstop-provision starter workspace', { userId, error: (err as Error).message });
  }
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const pool = getPool();
    if (await findUserByEmail(pool, body.email)) {
      throw ApiError.conflict('An account with that email already exists');
    }
    const user = await createUser(pool, {
      email: body.email,
      name: body.name,
      passwordHash: await bcrypt.hash(body.password, 10),
    });
    // Every account gets a starting organization so the dashboard is usable
    // immediately; users can create/join more later.
    const orgName = body.organizationName ?? `${body.name}'s Workspace`;
    const slugBase = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
    const org = await createOrganization(pool, {
      name: orgName,
      slug: `${slugBase}-${user.id.slice(0, 8)}`,
      createdBy: user.id,
    });
    // Best-effort: a populated dashboard on first login is a big part of the
    // product experience, but must never block account creation if it fails.
    try {
      await provisionStarterWorkspace(pool, { orgId: org.id, userId: user.id });
    } catch (err) {
      log.error('failed to provision starter workspace', { userId: user.id, error: (err as Error).message });
    }
    res.status(201).json({
      token: signToken(user),
      user: { id: user.id, email: user.email, name: user.name },
      organization: { id: org.id, name: org.name, slug: org.slug },
    });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await findUserByEmail(getPool(), body.email);
    // Same error for unknown email and bad password — no account enumeration.
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw ApiError.unauthorized('Invalid email or password');
    }
    await ensureStarterWorkspace(user.id);
    res.json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name } });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const user = await findUserById(getPool(), req.userId);
    if (!user) throw ApiError.unauthorized();
    await ensureStarterWorkspace(user.id);
    const orgs = await listOrganizationsForUser(getPool(), user.id);
    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      organizations: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
    });
  }),
);
