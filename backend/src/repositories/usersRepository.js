import { pool } from '../db/pool.js';

const PUBLIC_COLUMNS = 'id, email, full_name, role, is_active, created_at';

export function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: Boolean(row.is_active),
  };
}

export async function findById(id) {
  const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

// Includes password_hash: only for the login flow.
export async function findByEmailWithHash(email) {
  const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = ?`, [email]);
  return rows[0] ?? null;
}

export async function create({ email, fullName, role, passwordHash }) {
  const [result] = await pool.execute(
    'INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, ?)',
    [email, fullName, role, passwordHash],
  );
  return result.insertId;
}

// Admin view: adds whether the account can log in yet and its creation date.
export function toAdminUser(row) {
  return {
    ...toPublicUser(row),
    hasPassword: Boolean(row.has_password),
    createdAt: row.created_at,
  };
}

export async function list({ includeInactive = true } = {}) {
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash IS NOT NULL AS has_password FROM users
     ${includeInactive ? '' : 'WHERE is_active = TRUE'}
     ORDER BY is_active DESC, full_name ASC`,
  );
  return rows;
}

export async function findAdminViewById(id) {
  const [rows] = await pool.execute(
    `SELECT ${PUBLIC_COLUMNS}, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?`,
    [id],
  );
  return rows[0] ?? null;
}

const UPDATABLE = { email: 'email', fullName: 'full_name', role: 'role', isActive: 'is_active' };

export async function update(id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => UPDATABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${UPDATABLE[key]} = ?`).join(', ');
  await pool.execute(`UPDATE users SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

/** Returns the ids from `ids` that belong to active users. */
export async function findActiveIds(ids) {
  if (ids.length === 0) return [];
  const [rows] = await pool.query('SELECT id FROM users WHERE is_active = TRUE AND id IN (?)', [ids]);
  return rows.map((r) => r.id);
}
