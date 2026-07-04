import type { Db } from '../db.js';
import type { Project } from '../types.js';

export async function createProject(
  db: Db,
  input: { orgId: string; name: string; slug: string; description?: string; createdBy: string },
): Promise<Project> {
  const { rows } = await db.query(
    `INSERT INTO projects (org_id, name, slug, description, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.orgId, input.name, input.slug, input.description ?? '', input.createdBy],
  );
  return rows[0];
}

export async function listProjectsForUser(db: Db, userId: string): Promise<Array<Project & { org_name: string }>> {
  const { rows } = await db.query(
    `SELECT p.*, o.name AS org_name
       FROM projects p
       JOIN organizations o ON o.id = p.org_id
       JOIN organization_members m ON m.org_id = p.org_id
      WHERE m.user_id = $1
      ORDER BY p.created_at`,
    [userId],
  );
  return rows;
}

export async function getProjectById(db: Db, id: string): Promise<Project | null> {
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateProject(
  db: Db,
  id: string,
  patch: { name?: string; description?: string },
): Promise<Project | null> {
  const { rows } = await db.query(
    `UPDATE projects
        SET name = COALESCE($2, name), description = COALESCE($3, description)
      WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.description ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteProject(db: Db, id: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
