import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * Writes an audit entry on `conn` and throws on failure. Use inside a transaction when the
 * audit row must commit or roll back together with the change it describes.
 */
export async function recordAudit(conn, { actorUserId = null, action, entityType, entityId = null, before = null, after = null, ip = null }) {
  await conn.execute(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [actorUserId, action, entityType, entityId, before && JSON.stringify(before), after && JSON.stringify(after), ip],
  );
}

// Records an audit entry. Audit failures are logged but never break the request.
export async function audit(entry) {
  try {
    await recordAudit(pool, entry);
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, error: err.message });
  }
}
