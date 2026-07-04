import { Router } from 'express';
import {
  createProject,
  createRetryPolicy,
  deleteProject,
  deleteRetryPolicy,
  getPool,
  getRetryPolicy,
  listProjectsForUser,
  listRetryPolicies,
  updateProject,
  updateRetryPolicy,
} from '@pulse/core';
import { assertOrgRole, assertProjectRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { createProjectSchema, retryPolicyBody, retryPolicyPatch, updateProjectSchema } from '../validate.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

projectsRouter.get(
  '/',
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json({ data: await listProjectsForUser(getPool(), req.userId) });
  }),
);

projectsRouter.post(
  '/orgs/:orgId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createProjectSchema.parse(req.body);
    await assertOrgRole(req.userId, req.params.orgId, 'admin');
    const project = await createProject(getPool(), {
      orgId: req.params.orgId,
      name: body.name,
      slug: body.slug,
      description: body.description,
      createdBy: req.userId,
    });
    res.status(201).json(project);
  }),
);

projectsRouter.get(
  '/:projectId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const project = await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json(project);
  }),
);

projectsRouter.patch(
  '/:projectId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = updateProjectSchema.parse(req.body);
    await assertProjectRole(req.userId, req.params.projectId, 'admin');
    res.json(await updateProject(getPool(), req.params.projectId, body));
  }),
);

projectsRouter.delete(
  '/:projectId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'owner');
    await deleteProject(getPool(), req.params.projectId);
    res.status(204).end();
  }),
);

// --- Retry policies (project-scoped) ---

projectsRouter.get(
  '/:projectId/retry-policies',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json({ data: await listRetryPolicies(getPool(), req.params.projectId) });
  }),
);

projectsRouter.post(
  '/:projectId/retry-policies',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = retryPolicyBody.parse(req.body);
    await assertProjectRole(req.userId, req.params.projectId, 'member');
    const policy = await createRetryPolicy(getPool(), { projectId: req.params.projectId, ...body });
    res.status(201).json(policy);
  }),
);

export const retryPoliciesRouter = Router();
retryPoliciesRouter.use(requireAuth);

retryPoliciesRouter.patch(
  '/:policyId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = retryPolicyPatch.parse(req.body);
    const policy = await getRetryPolicy(getPool(), req.params.policyId);
    if (!policy) throw ApiError.notFound('Retry policy');
    await assertProjectRole(req.userId, policy.project_id, 'member');
    res.json(await updateRetryPolicy(getPool(), req.params.policyId, body));
  }),
);

retryPoliciesRouter.delete(
  '/:policyId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const policy = await getRetryPolicy(getPool(), req.params.policyId);
    if (!policy) throw ApiError.notFound('Retry policy');
    await assertProjectRole(req.userId, policy.project_id, 'admin');
    await deleteRetryPolicy(getPool(), req.params.policyId);
    res.status(204).end();
  }),
);
