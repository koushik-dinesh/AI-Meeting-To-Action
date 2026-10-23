// Admin email notifications for a reviewed meeting (Phase 5): preview, send, status, retry.
// Sending only creates email_messages rows and jobs; the worker does the delivery.
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import * as queue from '../jobs/queue.js';
import * as messages from '../repositories/emailMessagesRepository.js';
import * as meetings from '../repositories/meetingsRepository.js';
import { audit } from '../services/audit.js';
import { email } from '../services/email/index.js';
import { renderActionItemsEmail } from '../services/email/templates/actionItemsEmail.js';
import { buildPlan } from '../services/notifications.js';
import { AppError, conflict, notFound } from '../utils/errors.js';

// Meeting statuses after the review is finished (PLANNING.md: approved -> emails_sent).
const SENDABLE_STATUSES = ['approved', 'emails_sent'];

export const emailJobKey = (messageId) => `email.send:message:${messageId}`;

function assertConfigured() {
  if (!email.isConfigured()) {
    throw new AppError(503, 'EMAIL_NOT_CONFIGURED', `Email sending is not configured on the server (${email.configurationProblem()})`);
  }
}

function assertSendable(meeting) {
  if (!meeting) throw notFound('Meeting not found');
  if (!SENDABLE_STATUSES.includes(meeting.status)) {
    throw new AppError(409, 'REVIEW_NOT_FINISHED', 'Finish reviewing the action items before sending notifications');
  }
}

/** Messages with their job's retry schedule, for status display. */
async function messagesWithJobs(meetingId) {
  const list = await messages.listForMeeting(meetingId);
  return Promise.all(
    list.map(async (m) => {
      const job = ['queued', 'retry', 'sending'].includes(m.status) ? await queue.findActiveByDedupeKey(emailJobKey(m.id)) : null;
      return { ...m, nextAttemptAt: job?.status === 'pending' ? job.runAt : null };
    }),
  );
}

export async function preview(req, res) {
  const { id } = req.params;
  const meeting = await meetings.findById(id);
  if (!meeting) throw notFound('Meeting not found');
  const plan = await buildPlan(id);

  const existing = new Map();
  for (const g of plan.groups) {
    const m = await messages.findByKey(g.idempotencyKey);
    if (m) existing.set(g.idempotencyKey, { id: m.id, status: m.status });
  }
  res.json({
    meetingStatus: meeting.status,
    canSend: SENDABLE_STATUSES.includes(meeting.status),
    emailConfigured: email.isConfigured(),
    recipients: plan.groups.map((g) => ({
      recipient: g.recipient,
      items: g.items.map(({ id: itemId, title, dueDate, priority }) => ({ id: itemId, title, dueDate, priority })),
      existingMessage: existing.get(g.idempotencyKey) ?? null,
    })),
    excluded: plan.excluded,
    notApproved: plan.notApproved,
  });
}

export async function send(req, res) {
  const { id } = req.params;
  assertConfigured();

  const result = await withTransaction(async (conn) => {
    // The meeting row lock serialises concurrent send requests for the same meeting;
    // the UNIQUE idempotency_key is the database-level backstop.
    const meeting = await meetings.findByIdForUpdate(conn, id);
    assertSendable(meeting);
    const plan = await buildPlan(id, conn);
    if (plan.groups.length === 0) {
      throw new AppError(409, 'NO_RECIPIENTS', 'No approved action items have an active assignee with an email address', plan.excluded.map((e) => ({ field: `actionItem:${e.itemId}`, message: `${e.title}: ${e.reason}` })));
    }

    const created = [];
    const existing = [];
    for (const g of plan.groups) {
      const found = await messages.findByKey(g.idempotencyKey, conn);
      if (found) {
        existing.push(found.id);
        continue;
      }
      const content = renderActionItemsEmail({
        meeting: { title: meeting.title, scheduledAt: meeting.scheduled_at },
        recipient: g.recipient,
        items: g.items,
        appUrl: config.email.appPublicUrl,
        timeZone: config.extraction.timezone,
      });
      const messageId = await messages.create(conn, {
        meetingId: id,
        recipientUserId: g.recipient.id,
        recipientEmail: g.recipient.email,
        ...content,
        idempotencyKey: g.idempotencyKey,
        itemIds: g.items.map((i) => i.id),
      });
      await queue.enqueue('email.send', { messageId, meetingId: id }, { dedupeKey: emailJobKey(messageId), maxAttempts: config.email.maxAttempts, conn });
      created.push(messageId);
    }
    return { created, existing, excluded: plan.excluded.length };
  });

  if (result.created.length) {
    await audit({
      actorUserId: req.user.id,
      action: 'emails.requested',
      entityType: 'meeting',
      entityId: id,
      after: { messageIds: result.created, alreadyRequested: result.existing.length, excludedItems: result.excluded },
      ip: req.ip,
    });
  }
  res.status(result.created.length ? 202 : 200).json({
    queued: result.created.length,
    alreadyRequested: result.existing.length,
    messages: await messagesWithJobs(id),
  });
}

export async function list(req, res) {
  const { id } = req.params;
  const meeting = await meetings.findById(id);
  if (!meeting) throw notFound('Meeting not found');
  res.json({ meetingStatus: meeting.status, messages: await messagesWithJobs(id) });
}

/** Re-queues one failed message. Sent messages can never be retried, so they are never resent. */
export async function retry(req, res) {
  const { id } = req.params;
  assertConfigured();
  const message = await withTransaction(async (conn) => {
    const unlocked = await messages.findById(id, { conn });
    if (!unlocked) throw notFound('Email not found');
    assertSendable(await meetings.findByIdForUpdate(conn, unlocked.meeting_id));
    const m = await messages.findById(id, { conn, forUpdate: true });
    if (m.status !== 'failed') throw conflict(`Only failed emails can be retried (this one is ${m.status})`);
    await messages.requeue(conn, id);
    try {
      await queue.enqueue('email.send', { messageId: m.id, meetingId: m.meeting_id }, { dedupeKey: emailJobKey(m.id), maxAttempts: config.email.maxAttempts, conn });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('This email is already being sent');
      throw err;
    }
    return m;
  });

  await audit({ actorUserId: req.user.id, action: 'email.retry_requested', entityType: 'email_message', entityId: id, before: { status: 'failed' }, after: { status: 'queued' }, ip: req.ip });
  const [updated] = (await messagesWithJobs(message.meeting_id)).filter((m) => m.id === Number(id));
  res.status(202).json({ message: updated });
}
