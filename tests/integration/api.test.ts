/**
 * API contract tests via supertest: auth, RBAC, CRUD, job submission
 * (immediate/delayed/batch/idempotent), filtering/pagination, error envelope.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createOrganization, createUser, getPool } from '@pulse/core';
import { createApp } from '../../apps/api/src/app';
import { uniq } from './helpers';

const app = createApp();

afterAll(async () => {
  await closePool();
});

interface Session {
  token: string;
  orgId: string;
  projectId: string;
}

async function registerAndSetup(): Promise<Session> {
  const email = `${uniq('api')}@test.dev`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email, name: 'API Tester', password: 'password123' })
    .expect(201);
  const token = reg.body.token;
  const orgId = reg.body.organization.id;
  const proj = await request(app)
    .post(`/api/projects/orgs/${orgId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Proj', slug: uniq('proj') })
    .expect(201);
  return { token, orgId, projectId: proj.body.id };
}

describe('auth', () => {
  it('registers, logs in, and returns the profile', async () => {
    const email = `${uniq('auth')}@test.dev`;
    await request(app)
      .post('/api/auth/register')
      .send({ email, name: 'U', password: 'password123' })
      .expect(201);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    expect(login.body.token).toBeTruthy();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0].role).toBe('owner');
  });

  it('rejects duplicate emails, bad credentials, and missing tokens', async () => {
    const email = `${uniq('dup')}@test.dev`;
    await request(app).post('/api/auth/register').send({ email, name: 'U', password: 'password123' }).expect(201);
    const dup = await request(app).post('/api/auth/register').send({ email, name: 'U', password: 'password123' }).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const bad = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    expect(bad.body.error.code).toBe('UNAUTHORIZED');

    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('returns a structured validation error envelope', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'nope', name: '', password: 'x' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    expect(res.body.error.details[0]).toHaveProperty('path');
  });

  it('auto-provisions a populated starter workspace so a brand-new account is never empty', async () => {
    const email = `${uniq('starter')}@test.dev`;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email, name: 'New User', password: 'password123' })
      .expect(201);
    const token = reg.body.token;
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    const projects = await auth(request(app).get('/api/projects')).expect(200);
    expect(projects.body.data).toHaveLength(1);
    const project = projects.body.data[0];
    expect(project.name).toBe('Getting Started');

    const queues = await auth(request(app).get(`/api/projects/${project.id}/queues`)).expect(200);
    expect(queues.body.data.map((q: { name: string }) => q.name).sort()).toEqual(['background', 'critical']);

    const schedules = await auth(request(app).get(`/api/projects/${project.id}/schedules`)).expect(200);
    expect(schedules.body.data).toHaveLength(1);

    // Historical jobs across every lifecycle state, so Overview/pipeline/DLQ
    // all show real data on first login, independent of whether a worker
    // process happens to be running.
    const jobs = await auth(request(app).get(`/api/projects/${project.id}/jobs`)).expect(200);
    const byStatus: Record<string, number> = {};
    for (const j of jobs.body.data as Array<{ status: string }>) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    expect(byStatus.completed).toBe(5);
    expect(byStatus.dead_letter).toBe(1);
    expect(byStatus.queued).toBeGreaterThanOrEqual(1);

    const dlq = await auth(request(app).get(`/api/projects/${project.id}/dlq`)).expect(200);
    expect(dlq.body.data).toHaveLength(1);
    expect(dlq.body.data[0].attempts_made).toBe(2);

    const overview = await auth(request(app).get(`/api/projects/${project.id}/metrics/overview`)).expect(200);
    expect(overview.body.status_counts.completed).toBe(5);
    expect(overview.body.dead_letter_active).toBe(1);

    // The "edit project" UI relies on this endpoint to rename/re-describe
    // the auto-provisioned project — nothing about it is permanently fixed.
    const renamed = await auth(request(app).patch(`/api/projects/${project.id}`))
      .send({ name: 'My Renamed Project', description: 'Customized after registration' })
      .expect(200);
    expect(renamed.body.name).toBe('My Renamed Project');
  });

  it('backstops pre-existing empty accounts on login (not just at registration time)', async () => {
    // Simulate an account created before the auto-provisioning feature
    // existed: a user + org with zero projects, built directly through the
    // repos rather than the /register endpoint.
    const pool = getPool();
    const email = `${uniq('legacy')}@test.dev`;
    const user = await createUser(pool, { email, name: 'Legacy User', passwordHash: await bcrypt.hash('password123', 4) });
    await createOrganization(pool, { name: 'Legacy Org', slug: uniq('legacy-org'), createdBy: user.id });

    const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' }).expect(200);
    const projects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(projects.body.data).toHaveLength(1);
    expect(projects.body.data[0].name).toBe('Getting Started');
  });
});

describe('RBAC', () => {
  it('blocks viewers from writes and non-members entirely', async () => {
    const owner = await registerAndSetup();
    const viewerEmail = `${uniq('viewer')}@test.dev`;
    const viewerReg = await request(app)
      .post('/api/auth/register')
      .send({ email: viewerEmail, name: 'Viewer', password: 'password123' })
      .expect(201);

    // Not a member yet → 404 (no resource existence leak)
    await request(app)
      .get(`/api/projects/${owner.projectId}/queues`)
      .set('Authorization', `Bearer ${viewerReg.body.token}`)
      .expect(404);

    await request(app)
      .post(`/api/orgs/${owner.orgId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: viewerEmail, role: 'viewer' })
      .expect(201);

    // Viewer can read…
    await request(app)
      .get(`/api/projects/${owner.projectId}/queues`)
      .set('Authorization', `Bearer ${viewerReg.body.token}`)
      .expect(200);
    // …but cannot create queues
    const denied = await request(app)
      .post(`/api/projects/${owner.projectId}/queues`)
      .set('Authorization', `Bearer ${viewerReg.body.token}`)
      .send({ name: 'q1' })
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });
});

describe('queues and jobs through the API', () => {
  it('creates queues, submits jobs (immediate/delayed/batch), lists with filters', async () => {
    const s = await registerAndSetup();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);

    const queue = (
      await auth(request(app).post(`/api/projects/${s.projectId}/queues`))
        .send({ name: 'work', maxConcurrency: 5, priority: 10 })
        .expect(201)
    ).body;

    const immediate = (
      await auth(request(app).post(`/api/queues/${queue.id}/jobs`))
        .send({ type: 'email.send', payload: { to: 'a@b.co' } })
        .expect(201)
    ).body;
    expect(immediate.status).toBe('queued');

    const delayed = (
      await auth(request(app).post(`/api/queues/${queue.id}/jobs`))
        .send({ type: 'demo.sleep', delayMs: 3_600_000 })
        .expect(201)
    ).body;
    expect(delayed.status).toBe('scheduled');

    const batch = (
      await auth(request(app).post(`/api/queues/${queue.id}/jobs/batch`))
        .send({ jobs: [{ type: 'demo.compute' }, { type: 'demo.compute' }, { type: 'demo.compute' }] })
        .expect(201)
    ).body;
    expect(batch.count).toBe(3);
    expect(new Set(batch.jobs.map((j: { batch_id: string }) => j.batch_id)).size).toBe(1);

    // Filtering + pagination
    const queuedOnly = (
      await auth(request(app).get(`/api/projects/${s.projectId}/jobs?status=queued&limit=2&offset=0`)).expect(200)
    ).body;
    expect(queuedOnly.pagination.total).toBe(4); // immediate + 3 batch
    expect(queuedOnly.data).toHaveLength(2);

    const byBatch = (
      await auth(request(app).get(`/api/projects/${s.projectId}/jobs?batchId=${batch.batchId}`)).expect(200)
    ).body;
    expect(byBatch.pagination.total).toBe(3);

    const badStatus = await auth(request(app).get(`/api/projects/${s.projectId}/jobs?status=bogus`)).expect(400);
    expect(badStatus.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('deduplicates by idempotency key', async () => {
    const s = await registerAndSetup();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);
    const queue = (
      await auth(request(app).post(`/api/projects/${s.projectId}/queues`)).send({ name: 'idem' }).expect(201)
    ).body;

    const first = await auth(request(app).post(`/api/queues/${queue.id}/jobs`))
      .send({ type: 't', idempotencyKey: 'charge-42' })
      .expect(201);
    const second = await auth(request(app).post(`/api/queues/${queue.id}/jobs`))
      .send({ type: 't', idempotencyKey: 'charge-42' })
      .expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.deduplicated).toBe(true);
  });

  it('pause/resume and queue config round-trip', async () => {
    const s = await registerAndSetup();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);
    const queue = (
      await auth(request(app).post(`/api/projects/${s.projectId}/queues`)).send({ name: 'cfg' }).expect(201)
    ).body;

    const paused = (await auth(request(app).post(`/api/queues/${queue.id}/pause`)).expect(200)).body;
    expect(paused.is_paused).toBe(true);
    const resumed = (await auth(request(app).post(`/api/queues/${queue.id}/resume`)).expect(200)).body;
    expect(resumed.is_paused).toBe(false);

    const updated = (
      await auth(request(app).patch(`/api/queues/${queue.id}`)).send({ maxConcurrency: 42, priority: 7 }).expect(200)
    ).body;
    expect(updated.max_concurrency).toBe(42);
    expect(updated.priority).toBe(7);
  });

  it('creates and validates cron schedules', async () => {
    const s = await registerAndSetup();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);
    const queue = (
      await auth(request(app).post(`/api/projects/${s.projectId}/queues`)).send({ name: 'cron' }).expect(201)
    ).body;

    const schedule = (
      await auth(request(app).post(`/api/projects/${s.projectId}/schedules`))
        .send({ queueId: queue.id, name: 'nightly', cronExpression: '0 0 * * *', jobType: 'demo.compute' })
        .expect(201)
    ).body;
    expect(new Date(schedule.next_run_at).getTime()).toBeGreaterThan(Date.now());

    const bad = await auth(request(app).post(`/api/projects/${s.projectId}/schedules`))
      .send({ queueId: queue.id, name: 'broken', cronExpression: 'not-cron', jobType: 't' })
      .expect(400);
    expect(bad.body.error.message).toMatch(/Invalid cron/);

    const pausedSchedule = (
      await auth(request(app).patch(`/api/schedules/${schedule.id}`)).send({ status: 'paused' }).expect(200)
    ).body;
    expect(pausedSchedule.status).toBe('paused');
  });

  it('serves health and metrics', async () => {
    const s = await registerAndSetup();
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.database).toBe('up');

    const overview = await request(app)
      .get(`/api/projects/${s.projectId}/metrics/overview`)
      .set('Authorization', `Bearer ${s.token}`)
      .expect(200);
    expect(overview.body).toHaveProperty('status_counts');
    expect(overview.body).toHaveProperty('workers_online');

    const throughput = await request(app)
      .get(`/api/projects/${s.projectId}/metrics/throughput?windowMinutes=10&bucketSeconds=60`)
      .set('Authorization', `Bearer ${s.token}`)
      .expect(200);
    expect(throughput.body.data.length).toBeGreaterThan(0);
  });
});

describe('cron scheduler materialisation', () => {
  it('fires due schedules exactly once (idempotency key collapse)', async () => {
    const s = await registerAndSetup();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);
    const queue = (
      await auth(request(app).post(`/api/projects/${s.projectId}/queues`)).send({ name: 'mat' }).expect(201)
    ).body;
    const schedule = (
      await auth(request(app).post(`/api/projects/${s.projectId}/schedules`))
        .send({ queueId: queue.id, name: 'due-now', cronExpression: '* * * * *', jobType: 'demo.compute' })
        .expect(201)
    ).body;

    // Force it due, then materialise twice — only one job may appear.
    await getPool().query(`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [schedule.id]);
    const { materialiseCronSchedules } = await import('../../apps/scheduler/src/tick');
    expect(await materialiseCronSchedules()).toBe(1);
    expect(await materialiseCronSchedules()).toBe(0); // next_run_at advanced

    const jobs = (
      await auth(request(app).get(`/api/projects/${s.projectId}/jobs?scheduledJobId=${schedule.id}`)).expect(200)
    ).body;
    expect(jobs.pagination.total).toBe(1);
    expect(jobs.data[0].type).toBe('demo.compute');
  });
});
