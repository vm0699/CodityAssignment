import { Router } from 'express';
import {
  addMember,
  createOrganization,
  findUserByEmail,
  getPool,
  listMembers,
  listOrganizationsForUser,
  removeMember,
} from '@pulse/core';
import { assertOrgRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { addMemberSchema, createOrgSchema } from '../validate.js';

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

orgsRouter.get(
  '/',
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json({ data: await listOrganizationsForUser(getPool(), req.userId) });
  }),
);

orgsRouter.post(
  '/',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createOrgSchema.parse(req.body);
    const org = await createOrganization(getPool(), { name: body.name, slug: body.slug, createdBy: req.userId });
    res.status(201).json(org);
  }),
);

orgsRouter.get(
  '/:orgId/members',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertOrgRole(req.userId, req.params.orgId, 'viewer');
    res.json({ data: await listMembers(getPool(), req.params.orgId) });
  }),
);

orgsRouter.post(
  '/:orgId/members',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = addMemberSchema.parse(req.body);
    await assertOrgRole(req.userId, req.params.orgId, 'admin');
    const user = await findUserByEmail(getPool(), body.email);
    if (!user) throw ApiError.notFound('User with that email');
    await addMember(getPool(), req.params.orgId, user.id, body.role);
    res.status(201).json({ userId: user.id, role: body.role });
  }),
);

orgsRouter.delete(
  '/:orgId/members/:userId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertOrgRole(req.userId, req.params.orgId, 'admin');
    const removed = await removeMember(getPool(), req.params.orgId, req.params.userId);
    if (!removed) throw ApiError.badRequest('Member not found or is the owner');
    res.status(204).end();
  }),
);
