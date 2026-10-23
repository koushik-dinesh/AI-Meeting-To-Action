// Which emails a meeting's review produces (Phase 5).
//
// Recipients come only from the users table: an approved action item's assignee_user_id, that
// user's current email address, and only if the user is active. Nothing from the AI output or
// the client decides who receives mail.
//
// Idempotency (PLANNING.md §1): one email_messages row per (meeting, recipient, set of items),
// with idempotency_key = sha256(meetingId:userId:sorted item ids) and a UNIQUE index. Asking
// to send again for the same approved items never creates a second message. If the set of a
// recipient's approved items changes later, the key changes and a new message (for the new
// set) is allowed; edits to an item's text alone do not trigger a resend.
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const idempotencyKeyFor = (meetingId, userId, itemIds) =>
  createHash('sha256').update(`${meetingId}:${userId}:${[...itemIds].sort((a, b) => a - b).join(',')}`).digest('hex');

/**
 * @returns {{ groups: [{ recipient: {id, fullName, email}, items: [...], idempotencyKey }],
 *             excluded: [{ itemId, title, reason }], notApproved: { pending, rejected } }}
 */
export async function buildPlan(meetingId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT ai.id, ai.title, ai.description, DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date, ai.priority, ai.review_status,
            u.id AS user_id, u.full_name, u.email, u.is_active
     FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id
     WHERE ai.meeting_id = ? ORDER BY ai.id`,
    [meetingId],
  );

  const notApproved = { pending: 0, rejected: 0 };
  const excluded = [];
  const byUser = new Map();
  for (const r of rows) {
    if (r.review_status !== 'approved') {
      notApproved[r.review_status]++;
      continue;
    }
    const reason = !r.user_id
      ? 'No assignee'
      : !r.is_active
        ? `${r.full_name} is inactive`
        : !EMAIL_RE.test(r.email ?? '')
          ? `${r.full_name} has no valid email address`
          : null;
    if (reason) {
      excluded.push({ itemId: r.id, title: r.title, reason });
      continue;
    }
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { recipient: { id: r.user_id, fullName: r.full_name, email: r.email }, items: [] });
    byUser.get(r.user_id).items.push({ id: r.id, title: r.title, description: r.description, dueDate: r.due_date, priority: r.priority });
  }

  const groups = [...byUser.values()]
    .sort((a, b) => a.recipient.fullName.localeCompare(b.recipient.fullName))
    .map((g) => ({ ...g, idempotencyKey: idempotencyKeyFor(meetingId, g.recipient.id, g.items.map((i) => i.id)) }));
  return { groups, excluded, notApproved };
}
