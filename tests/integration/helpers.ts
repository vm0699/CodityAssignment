import bcrypt from 'bcryptjs';
import {
  createOrganization,
  createProject,
  createQueue,
  createUser,
  getPool,
  type Project,
  type Queue,
  type User,
} from '@pulse/core';

let counter = 0;

/** Cheap unique suffix so fixtures never collide across tests. */
export function uniq(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export interface Fixture {
  user: User;
  projectId: string;
  project: Project;
  queue: Queue;
}

/** Creates user → org → project → queue directly through the repos. */
export async function createFixture(queueOpts: Partial<Parameters<typeof createQueue>[1]> = {}): Promise<Fixture> {
  const pool = getPool();
  const user = await createUser(pool, {
    email: `${uniq('user')}@test.dev`,
    name: 'Test User',
    passwordHash: await bcrypt.hash('password123', 4),
  });
  const org = await createOrganization(pool, { name: 'Test Org', slug: uniq('org'), createdBy: user.id });
  const project = await createProject(pool, {
    orgId: org.id,
    name: 'Test Project',
    slug: uniq('proj'),
    createdBy: user.id,
  });
  const queue = await createQueue(pool, {
    projectId: project.id,
    name: uniq('queue'),
    maxConcurrency: 10,
    ...queueOpts,
  });
  return { user, projectId: project.id, project, queue };
}

/** Registers a fake worker row directly (no worker process needed in tests). */
export async function createTestWorker(name = uniq('w')): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO workers (name, hostname, pid, concurrency) VALUES ($1, 'test-host', 1, 10) RETURNING id`,
    [name],
  );
  return rows[0].id;
}
