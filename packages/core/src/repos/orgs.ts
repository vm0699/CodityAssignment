import type { Db } from '../db.js';
import type { Organization, OrganizationMember, OrgRole } from '../types.js';

export async function createOrganization(
  db: Db,
  input: { name: string; slug: string; createdBy: string },
): Promise<Organization> {
  const { rows } = await db.query(
    `INSERT INTO organizations (name, slug, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, input.slug, input.createdBy],
  );
  const org: Organization = rows[0];
  await db.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org.id, input.createdBy],
  );
  return org;
}

export async function listOrganizationsForUser(
  db: Db,
  userId: string,
): Promise<Array<Organization & { role: OrgRole }>> {
  const { rows } = await db.query(
    `SELECT o.*, m.role
       FROM organizations o
       JOIN organization_members m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.created_at`,
    [userId],
  );
  return rows;
}

export async function getMembership(db: Db, orgId: string, userId: string): Promise<OrganizationMember | null> {
  const { rows } = await db.query(
    `SELECT * FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  return rows[0] ?? null;
}

export async function listMembers(
  db: Db,
  orgId: string,
): Promise<Array<{ user_id: string; email: string; name: string; role: OrgRole; created_at: Date }>> {
  const { rows } = await db.query(
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at
       FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 ORDER BY m.created_at`,
    [orgId],
  );
  return rows;
}

export async function addMember(db: Db, orgId: string, userId: string, role: OrgRole): Promise<void> {
  await db.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, userId, role],
  );
}

export async function removeMember(db: Db, orgId: string, userId: string): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [orgId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
