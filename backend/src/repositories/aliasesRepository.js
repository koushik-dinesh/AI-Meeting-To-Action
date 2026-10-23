import { pool } from '../db/pool.js';

export const toAlias = (row) => ({ id: row.id, userId: row.user_id, alias: row.alias, createdAt: row.created_at });

export async function listForUser(userId) {
  const [rows] = await pool.execute(
    'SELECT id, user_id, alias, created_at FROM user_aliases WHERE user_id = ? ORDER BY alias',
    [userId],
  );
  return rows;
}

export async function listAll() {
  const [rows] = await pool.query('SELECT id, user_id, alias, created_at FROM user_aliases ORDER BY alias');
  return rows;
}

export async function findById(userId, aliasId) {
  const [rows] = await pool.execute(
    'SELECT id, user_id, alias, created_at FROM user_aliases WHERE id = ? AND user_id = ?',
    [aliasId, userId],
  );
  return rows[0] ?? null;
}

/** Other users that already use this normalized alias (aliases may be shared, but admins should know). */
export async function findOwnersOfNormalized(normalized, excludeUserId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name FROM user_aliases a JOIN users u ON u.id = a.user_id
     WHERE a.normalized_alias = ? AND a.user_id <> ?`,
    [normalized, excludeUserId],
  );
  return rows;
}

export async function create(userId, alias, normalized) {
  const [result] = await pool.execute(
    'INSERT INTO user_aliases (user_id, alias, normalized_alias) VALUES (?, ?, ?)',
    [userId, alias, normalized],
  );
  return result.insertId;
}

export async function remove(userId, aliasId) {
  const [result] = await pool.execute('DELETE FROM user_aliases WHERE id = ? AND user_id = ?', [aliasId, userId]);
  return result.affectedRows > 0;
}
