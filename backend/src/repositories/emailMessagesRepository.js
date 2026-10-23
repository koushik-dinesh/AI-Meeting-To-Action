import { pool } from '../db/pool.js';

// html_body/text_body are not part of the API shape (they stay in the DB as the record of what was sent).
export const toEmailMessage = (row) => ({
  id: row.id,
  meetingId: row.meeting_id,
  recipient: { id: row.recipient_user_id, fullName: row.recipient_full_name ?? null, email: row.recipient_email },
  subject: row.subject,
  status: row.status,
  provider: row.provider,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  sentAt: row.sent_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function findByKey(idempotencyKey, conn = pool) {
  const [rows] = await conn.execute('SELECT * FROM email_messages WHERE idempotency_key = ?', [idempotencyKey]);
  return rows[0] ?? null;
}

export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT * FROM email_messages WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ?? null;
}

export async function create(conn, { meetingId, recipientUserId, recipientEmail, subject, html, text, idempotencyKey, itemIds }) {
  const [result] = await conn.execute(
    `INSERT INTO email_messages (meeting_id, recipient_user_id, recipient_email, subject, html_body, text_body, idempotency_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [meetingId, recipientUserId, recipientEmail, subject, html, text, idempotencyKey],
  );
  await conn.query('INSERT INTO email_message_items (email_message_id, action_item_id) VALUES ?', [itemIds.map((itemId) => [result.insertId, itemId])]);
  return result.insertId;
}

/** Messages for a meeting with recipient names and included item titles. */
export async function listForMeeting(meetingId) {
  const [rows] = await pool.execute(
    `SELECT m.*, u.full_name AS recipient_full_name
     FROM email_messages m JOIN users u ON u.id = m.recipient_user_id
     WHERE m.meeting_id = ? ORDER BY u.full_name, m.id`,
    [meetingId],
  );
  if (rows.length === 0) return [];
  const [items] = await pool.query(
    `SELECT emi.email_message_id, ai.id, ai.title FROM email_message_items emi
     JOIN action_items ai ON ai.id = emi.action_item_id
     WHERE emi.email_message_id IN (?) ORDER BY ai.id`,
    [rows.map((r) => r.id)],
  );
  const byMessage = Map.groupBy(items, (i) => i.email_message_id);
  return rows.map((r) => ({ ...toEmailMessage(r), items: (byMessage.get(r.id) ?? []).map((i) => ({ id: i.id, title: i.title })) }));
}

/** Current eligibility facts for a message: is the recipient still active with the same address, are all items approved. */
export async function eligibility(messageId) {
  const [[row]] = await pool.query(
    `SELECT u.is_active, u.email AS current_email, m.recipient_email,
            (SELECT COUNT(*) FROM email_message_items emi JOIN action_items ai ON ai.id = emi.action_item_id
             WHERE emi.email_message_id = m.id AND ai.review_status <> 'approved') AS unapproved
     FROM email_messages m JOIN users u ON u.id = m.recipient_user_id WHERE m.id = ?`,
    [messageId],
  );
  return row
    ? { active: Boolean(row.is_active), sameAddress: row.current_email === row.recipient_email, unapproved: Number(row.unapproved) }
    : null;
}

/** queued|retry -> sending. Returns false if another worker already took it or it isn't sendable. */
export async function claimForSending(id, provider) {
  const [r] = await pool.execute(
    `UPDATE email_messages SET status = 'sending', provider = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL
     WHERE id = ? AND status IN ('queued','retry')`,
    [provider, id],
  );
  return r.affectedRows > 0;
}

export async function recordAttempt(id, { success, error = null, response = null }) {
  await pool.execute('INSERT INTO email_attempts (email_message_id, success, error, provider_response) VALUES (?, ?, ?, ?)', [
    id, success, error, response && JSON.stringify(response),
  ]);
}

export async function markSent(id, providerMessageId) {
  await pool.execute(
    `UPDATE email_messages SET status = 'sent', provider_message_id = ?, sent_at = NOW(), last_error = NULL, next_attempt_at = NULL
     WHERE id = ? AND status = 'sending'`,
    [String(providerMessageId ?? '').slice(0, 255) || null, id],
  );
}

export async function markRetry(id, error, delaySeconds) {
  await pool.execute(
    `UPDATE email_messages SET status = 'retry', last_error = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id = ? AND status IN ('sending','queued','retry')`,
    [error, delaySeconds, id],
  );
}

/** Any non-sent status -> failed. A sent message is never downgraded. */
export async function markFailed(id, error) {
  await pool.execute(
    "UPDATE email_messages SET status = 'failed', last_error = ?, next_attempt_at = NULL WHERE id = ? AND status <> 'sent'",
    [error, id],
  );
}

export async function requeue(conn, id) {
  await conn.execute("UPDATE email_messages SET status = 'queued', last_error = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'failed'", [id]);
}

export async function countUnsent(meetingId, conn = pool) {
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM email_messages WHERE meeting_id = ? AND status <> 'sent'", [meetingId]);
  return Number(n);
}
