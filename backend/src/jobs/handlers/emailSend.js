// Job 'email.send' { messageId, meetingId }: delivers one email_messages row.
//
// - A message is sent at most once by this system: 'sent' is final, and the queued|retry ->
//   sending transition is a conditional UPDATE, so two workers can't both send it.
// - No transaction is open while the provider is called.
// - If a worker dies after claiming a message (status left at 'sending'), we can't know whether
//   the provider accepted it. The recovered job then marks it failed with an explanation rather
//   than risk a duplicate; an admin can retry it explicitly. (With Resend the Idempotency-Key
//   would also make a resend a no-op for 24h.)
// - "sent" means the SMTP server / Resend API accepted the message. It does not prove the
//   email reached the recipient's inbox.
import { pool } from '../../db/pool.js';
import * as messages from '../../repositories/emailMessagesRepository.js';
import { audit } from '../../services/audit.js';
import { email } from '../../services/email/index.js';
import { sanitize } from '../../services/email/errors.js';
import { logger } from '../../utils/logger.js';
import { PermanentJobError, backoffMs } from '../queue.js';

const INTERRUPTED = 'Sending was interrupted (worker stopped). It may or may not have been delivered; check before retrying.';

async function run(job) {
  const { messageId } = job.payload;
  const message = await messages.findById(messageId);
  if (!message) throw new PermanentJobError(`Email message ${messageId} not found`);
  if (message.status === 'sent') {
    logger.info('email already sent; nothing to do', { jobId: job.id, messageId });
    return;
  }
  if (message.status === 'failed') {
    logger.warn('email is marked failed; not sending', { jobId: job.id, messageId });
    return;
  }
  if (message.status === 'sending') {
    await messages.markFailed(messageId, INTERRUPTED);
    throw new PermanentJobError(INTERRUPTED, { publicMessage: INTERRUPTED });
  }

  let provider;
  try {
    provider = email.getProvider();
  } catch (err) {
    throw new PermanentJobError(`Email not configured: ${err.message}`, { publicMessage: 'Email sending is not configured on the server' });
  }

  // Re-check eligibility at send time: never send for unapproved items or to an inactive or changed recipient.
  const facts = await messages.eligibility(messageId);
  if (!facts?.active) throw new PermanentJobError('Recipient is inactive', { publicMessage: 'The recipient is no longer active' });
  if (!facts.sameAddress) throw new PermanentJobError('Recipient email address changed since the email was prepared', { publicMessage: 'The recipient’s email address has changed' });
  if (facts.unapproved > 0) throw new PermanentJobError('Message includes items that are no longer approved', { publicMessage: 'Some items are no longer approved' });

  if (!(await messages.claimForSending(messageId, provider.name))) {
    logger.warn('email could not be claimed (already in progress or done)', { jobId: job.id, messageId });
    return;
  }

  let result;
  try {
    result = await provider.send({
      from: email.from(),
      to: message.recipient_email,
      subject: message.subject,
      html: message.html_body,
      text: message.text_body,
      idempotencyKey: message.idempotency_key,
    });
  } catch (err) {
    const error = sanitize(err.message);
    await messages.recordAttempt(messageId, { success: false, error });
    const willRetry = err.retryable !== false && job.attempts < job.maxAttempts;
    if (willRetry) await messages.markRetry(messageId, err.publicMessage ?? error, Math.ceil(backoffMs(job.attempts) / 1000));
    else await messages.markFailed(messageId, err.publicMessage ?? error);
    err.message = error;
    throw err; // the queue schedules the retry (or stops) based on err.retryable
  }

  await messages.recordAttempt(messageId, { success: true, response: { messageId: result.messageId, response: result.response } });
  await messages.markSent(messageId, result.messageId);
  logger.info('email sent', { jobId: job.id, messageId, meetingId: message.meeting_id, provider: provider.name, attempt: job.attempts });
  await audit({ action: 'email.sent', entityType: 'email_message', entityId: messageId, after: { status: 'sent', provider: provider.name, recipientUserId: message.recipient_user_id } });

  // When every message of the meeting is sent, the meeting reaches 'emails_sent'.
  // Conditional UPDATE so concurrent final sends transition (and audit) only once.
  if ((await messages.countUnsent(message.meeting_id)) === 0) {
    const [r] = await pool.execute("UPDATE meetings SET status = 'emails_sent' WHERE id = ? AND status = 'approved'", [message.meeting_id]);
    if (r.affectedRows > 0) {
      await audit({ action: 'meeting.emails_sent', entityType: 'meeting', entityId: message.meeting_id, before: { status: 'approved' }, after: { status: 'emails_sent' } });
    }
  }
}

/** Makes sure a message never stays 'queued'/'sending'/'retry' after its job gave up. */
async function onFailure(job, err, { final }) {
  if (!final) return;
  const { messageId } = job.payload;
  const reason = err.publicMessage ?? sanitize(err.message);
  await messages.markFailed(messageId, reason);
  await audit({ action: 'email.failed', entityType: 'email_message', entityId: messageId, after: { status: 'failed', error: reason } });
}

export const emailSend = { run, onFailure };
