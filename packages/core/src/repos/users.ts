import type { Db } from '../db.js';
import type { User } from '../types.js';

export async function createUser(db: Db, input: { email: string; name: string; passwordHash: string }): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [input.email, input.name, input.passwordHash],
  );
  return rows[0];
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
