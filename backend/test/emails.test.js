// Email notifications end to end: API -> email_messages + jobs -> worker -> (fake) provider.
// No real email is sent: the provider is replaced by an in-memory fake.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlers } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext, recover } from '../src/jobs/runner.js';
import { EmailSendError } from '../src/services/email/errors.js';
import { email } from '../src/services/email/index.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const original = { ...email };
let admins;
let employee;
let adminId;
let u; // users
let sent; // what the fake provider received
let behaviour; // recipient email -> array of outcomes ('ok' | Error), consumed in order

const fakeProvider = {
  name: 'fake',
  async send(msg) {
    const next = behaviour[msg.to]?.shift() ?? 'ok';
    if (next instanceof Error) throw next;
    sent.push(msg);
    return { messageId: `fake-${sent.length}`, response: '250 OK' };
  },
};
const temporary = () => new EmailSendError('SMTP 451: try again later', { retryable: true, publicMessage: 'The mail server asked us to try again later' });
const permanent = () => new EmailSendError('SMTP 550: mailbox unavailable', { retryable: false, publicMessage: 'The mail server rejected the message or recipient address' });

let turn = 0;
const A = () => {
  const cookie = admins[turn++ % admins.length];
  return {
    get: (url) => request(app).get(url).set('Cookie', cookie),
    post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  };
};
const work = () => processNext('test-worker', handlers);
const drain = async () => {
  while (await work());
};
const msgs = async (meetingId) => (await pool.query('SELECT * FROM email_messages WHERE meeting_id = ? ORDER BY recipient_email', [meetingId]))[0];
const jobsFor = async () => (await pool.query("SELECT * FROM jobs WHERE type = 'email.send' ORDER BY id"))[0];
const makeAllDue = () => pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
const meetingStatus = async (id) => (await pool.query('SELECT status FROM meetings WHERE id = ?', [id]))[0][0].status;

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin', fullName: 'Ada Admin' });
  // Several admins: the send endpoint is rate limited to 10 requests/minute per admin.
  for (const n of [2, 3, 4, 5]) await createUser({ email: `admin${n}@example.test`, role: 'admin', fullName: `Admin ${n}` });
  await createUser({ email: 'emp@example.test', fullName: 'Eve Employee' });
  u = {
    raj: await createUser({ email: 'raj@example.test', fullName: 'Raj Patel' }),
    sam: await createUser({ email: 'sam@example.test', fullName: 'Sam Lee' }),
    gone: await createUser({ email: 'gone@example.test', fullName: 'Gone User', isActive: false }),
  };
  admins = [await loginCookie(app, 'admin@example.test')];
  for (const n of [2, 3, 4, 5]) admins.push(await loginCookie(app, `admin${n}@example.test`));
  employee = await loginCookie(app, 'emp@example.test');
});
beforeEach(async () => {
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM jobs');
  await pool.query('UPDATE users SET is_active = TRUE WHERE id IN (?, ?)', [u.raj, u.sam]);
  sent = [];
  behaviour = {};
  email.isConfigured = () => true;
  email.configurationProblem = () => null;
  email.getProvider = () => fakeProvider;
  email.from = () => 'Meeting to Action <no-reply@example.test>';
});
afterEach(() => Object.assign(email, original));
after(closeDatabase);

/** An approved meeting: Raj has 2 approved items, Sam 1; plus items that must never be emailed. */
async function approvedMeeting(status = 'approved') {
  const [m] = await pool.query(
    "INSERT INTO meetings (title, meeting_url, status, scheduled_at, created_by) VALUES ('Launch <sync>', 'https://meet.google.com/abc-defg-hij', ?, '2026-11-04 10:00:00', ?)",
    [status, adminId],
  );
  const item = async (title, assignee, reviewStatus = 'approved', dueDate = null) => {
    const [r] = await pool.query(
      `INSERT INTO action_items (meeting_id, title, description, assignee_user_id, assignee_match, due_date, priority, review_status, flags)
       VALUES (?, ?, 'desc', ?, 'manual', ?, 'medium', ?, '[]')`,
      [m.insertId, title, assignee, dueDate, reviewStatus],
    );
    return r.insertId;
  };
  const ids = {
    raj1: await item('Send the deck', u.raj, 'approved', '2026-11-06'),
    raj2: await item('Update pricing', u.raj),
    sam1: await item('Book the venue', u.sam),
    unassigned: await item('Nobody owns this', null),
    inactive: await item('Owned by a deactivated user', u.gone),
    rejected: await item('Rejected idea', u.raj, 'rejected'),
    pending: await item('Still pending', u.sam, 'pending'),
  };
  return { id: m.insertId, ids };
}

describe('authorization', () => {
  it('requires an admin for every email endpoint', async () => {
    const { id } = await approvedMeeting();
    for (const [method, url] of [
      ['get', `/api/v1/meetings/${id}/emails/preview`],
      ['post', `/api/v1/meetings/${id}/send-emails`],
      ['get', `/api/v1/meetings/${id}/emails`],
      ['post', '/api/v1/emails/1/retry'],
    ]) {
      assert.equal((await request(app)[method](url)).status, 401, url);
      assert.equal((await request(app)[method](url).set('Cookie', employee)).status, 403, url);
    }
    assert.equal((await msgs(id)).length, 0);
  });
});

describe('preview', () => {
  it('groups approved items by active recipient and explains exclusions', async () => {
    const { id, ids } = await approvedMeeting();
    const res = await A().get(`/api/v1/meetings/${id}/emails/preview`);
    assert.equal(res.status, 200);
    assert.equal(res.body.canSend, true);
    assert.deepEqual(
      res.body.recipients.map((r) => [r.recipient.email, r.items.map((i) => i.id)]),
      [
        ['raj@example.test', [ids.raj1, ids.raj2]],
        ['sam@example.test', [ids.sam1]],
      ],
    );
    assert.deepEqual(res.body.excluded.map((e) => [e.itemId, e.reason]), [
      [ids.unassigned, 'No assignee'],
      [ids.inactive, 'Gone User is inactive'],
    ]);
    assert.deepEqual(res.body.notApproved, { pending: 1, rejected: 1 });
    assert.equal(res.body.recipients[0].existingMessage, null);
    assert.equal(sent.length, 0);
  });

  it('reports when sending is not possible yet', async () => {
    const { id } = await approvedMeeting('review_pending');
    const res = await A().get(`/api/v1/meetings/${id}/emails/preview`);
    assert.equal(res.body.canSend, false);
  });
});

describe('requesting sends', () => {
  it('refuses before the review is finished and when email is not configured', async () => {
    const pendingReview = await approvedMeeting('review_pending');
    const res = await A().post(`/api/v1/meetings/${pendingReview.id}/send-emails`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'REVIEW_NOT_FINISHED');

    email.isConfigured = () => false;
    email.configurationProblem = () => 'EMAIL_PROVIDER is not set';
    const { id } = await approvedMeeting();
    const res2 = await A().post(`/api/v1/meetings/${id}/send-emails`);
    assert.equal(res2.status, 503);
    assert.equal(res2.body.error.code, 'EMAIL_NOT_CONFIGURED');
    assert.equal((await msgs(id)).length, 0);
  });

  it('refuses when no approved item has a valid recipient', async () => {
    const { id, ids } = await approvedMeeting();
    await pool.query('UPDATE action_items SET assignee_user_id = NULL WHERE id IN (?)', [[ids.raj1, ids.raj2, ids.sam1]]);
    const res = await A().post(`/api/v1/meetings/${id}/send-emails`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NO_RECIPIENTS');
  });

  it('queues one message per recipient with only their approved items', async () => {
    const { id, ids } = await approvedMeeting();
    const res = await A().post(`/api/v1/meetings/${id}/send-emails`);
    assert.equal(res.status, 202);
    assert.equal(res.body.queued, 2);
    assert.deepEqual(res.body.messages.map((m) => [m.recipient.fullName, m.status, m.items.length]), [
      ['Raj Patel', 'queued', 2],
      ['Sam Lee', 'queued', 1],
    ]);
    const rows = await msgs(id);
    assert.deepEqual(rows.map((r) => r.recipient_email), ['raj@example.test', 'sam@example.test']);
    const [linked] = await pool.query('SELECT action_item_id FROM email_message_items WHERE email_message_id = ? ORDER BY action_item_id', [rows[0].id]);
    assert.deepEqual(linked.map((l) => l.action_item_id), [ids.raj1, ids.raj2]);
    assert.ok(!rows[0].html_body.includes('Rejected idea'));
    assert.ok(!rows[1].html_body.includes('Still pending'));
    assert.equal((await jobsFor()).length, 2);
    assert.equal(sent.length, 0, 'nothing is sent by the request itself');
    const [[audit]] = await pool.query("SELECT action FROM audit_logs WHERE action = 'emails.requested' AND entity_id = ?", [id]);
    assert.ok(audit);
  });

  it('ignores repeated clicks: no duplicate messages or jobs', async () => {
    const { id } = await approvedMeeting();
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    const again = await A().post(`/api/v1/meetings/${id}/send-emails`);
    assert.equal(again.status, 200);
    assert.equal(again.body.queued, 0);
    assert.equal(again.body.alreadyRequested, 2);
    assert.equal((await msgs(id)).length, 2);
    assert.equal((await jobsFor()).length, 2);
  });

  it('creates exactly one set of messages under concurrent requests', async () => {
    const { id } = await approvedMeeting();
    const results = await Promise.all([1, 2, 3, 4].map(() => A().post(`/api/v1/meetings/${id}/send-emails`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 202]);
    assert.equal((await msgs(id)).length, 2);
    assert.equal((await jobsFor()).length, 2);
  });
});

describe('delivery', () => {
  it('sends each message once, records attempts, and marks the meeting emails_sent', async () => {
    const { id } = await approvedMeeting();
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    await drain();

    assert.deepEqual(sent.map((s) => s.to).sort(), ['raj@example.test', 'sam@example.test']);
    const raj = sent.find((s) => s.to === 'raj@example.test');
    assert.equal(raj.from, 'Meeting to Action <no-reply@example.test>');
    assert.equal(raj.subject, 'Your action items from "Launch <sync>"');
    assert.match(raj.html, /Launch &lt;sync&gt;/);
    assert.match(raj.text, /Send the deck/);
    assert.ok(!raj.html.includes('sam@example.test') && !raj.text.includes('sam@example.test'));
    assert.match(raj.idempotencyKey, /^[0-9a-f]{64}$/);

    const rows = await msgs(id);
    assert.deepEqual(rows.map((r) => [r.status, r.attempt_count, r.provider]), [
      ['sent', 1, 'fake'],
      ['sent', 1, 'fake'],
    ]);
    assert.ok(rows.every((r) => r.provider_message_id && r.sent_at));
    const [attempts] = await pool.query('SELECT success FROM email_attempts');
    assert.equal(attempts.length, 2);
    assert.equal(await meetingStatus(id), 'emails_sent');
    const [audits] = await pool.query("SELECT action FROM audit_logs WHERE action IN ('email.sent', 'meeting.emails_sent')");
    assert.equal(audits.filter((a) => a.action === 'email.sent').length, 2);
    assert.equal(audits.filter((a) => a.action === 'meeting.emails_sent').length, 1);

    // Asking again after everything was sent creates nothing new.
    const again = await A().post(`/api/v1/meetings/${id}/send-emails`);
    assert.equal(again.body.queued, 0);
    await drain();
    assert.equal(sent.length, 2);
  });

  it('retries a temporary failure for one recipient without resending the others', async () => {
    const { id } = await approvedMeeting();
    behaviour['sam@example.test'] = [temporary()];
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    await drain();

    let [raj, sam] = await msgs(id);
    assert.equal(raj.status, 'sent');
    assert.equal(sam.status, 'retry');
    assert.equal(sam.last_error, 'The mail server asked us to try again later');
    assert.ok(sam.next_attempt_at);
    assert.equal(await meetingStatus(id), 'approved', 'not all sent yet');

    const list = await A().get(`/api/v1/meetings/${id}/emails`);
    assert.ok(list.body.messages.find((m) => m.status === 'retry').nextAttemptAt);

    await makeAllDue();
    await drain();
    [raj, sam] = await msgs(id);
    assert.equal(sam.status, 'sent');
    assert.equal(sam.attempt_count, 2);
    assert.equal(sent.filter((s) => s.to === 'raj@example.test').length, 1, 'Raj not resent');
    const [att] = await pool.query('SELECT success FROM email_attempts WHERE email_message_id = ? ORDER BY id', [sam.id]);
    assert.deepEqual(att.map((a) => a.success), [0, 1]);
    assert.equal(await meetingStatus(id), 'emails_sent');
  });

  it('gives up after the maximum attempts', async () => {
    const { id } = await approvedMeeting();
    behaviour['sam@example.test'] = Array.from({ length: 10 }, temporary);
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    for (let i = 0; i < 10; i++) {
      await makeAllDue();
      await drain();
    }
    const [, sam] = await msgs(id);
    const [, job] = await jobsFor();
    assert.equal(sam.status, 'failed');
    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, job.max_attempts);
    assert.equal(sam.attempt_count, job.max_attempts);
    assert.equal(await meetingStatus(id), 'approved');
  });

  it('does not retry permanent failures, and an admin retry sends only the failed message', async () => {
    const { id } = await approvedMeeting();
    behaviour['sam@example.test'] = [permanent()];
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    await drain();

    let [raj, sam] = await msgs(id);
    assert.equal(sam.status, 'failed');
    assert.equal(sam.last_error, 'The mail server rejected the message or recipient address');
    assert.equal((await jobsFor()).find((j) => JSON.parse(JSON.stringify(j.payload)).messageId === sam.id).status, 'failed');

    // Sent and queued messages can't be retried.
    assert.equal((await A().post(`/api/v1/emails/${raj.id}/retry`)).status, 409);
    assert.equal((await A().post('/api/v1/emails/999999/retry')).status, 404);

    const retry = await A().post(`/api/v1/emails/${sam.id}/retry`);
    assert.equal(retry.status, 202);
    assert.equal(retry.body.message.status, 'queued');
    assert.equal((await A().post(`/api/v1/emails/${sam.id}/retry`)).status, 409, 'double-click on retry');

    await drain();
    [raj, sam] = await msgs(id);
    assert.equal(sam.status, 'sent');
    assert.equal(sent.filter((s) => s.to === 'raj@example.test').length, 1);
    assert.equal(sent.filter((s) => s.to === 'sam@example.test').length, 1);
    const [[audit]] = await pool.query("SELECT action FROM audit_logs WHERE action = 'email.retry_requested' AND entity_id = ?", [sam.id]);
    assert.ok(audit);
  });

  it('never sends to a recipient deactivated after queueing', async () => {
    const { id } = await approvedMeeting();
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [u.sam]);
    await drain();
    const [, sam] = await msgs(id);
    assert.equal(sam.status, 'failed');
    assert.equal(sam.last_error, 'The recipient is no longer active');
    assert.equal(sent.filter((s) => s.to === 'sam@example.test').length, 0);
  });

  it('fails clearly when the worker has no provider configured', async () => {
    const { id } = await approvedMeeting();
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    email.getProvider = () => {
      throw new Error('EMAIL_PROVIDER is not set');
    };
    await drain();
    const rows = await msgs(id);
    assert.ok(rows.every((r) => r.status === 'failed' && r.last_error === 'Email sending is not configured on the server'));
    assert.equal(sent.length, 0);
  });

  it('stores sanitized errors only', async () => {
    const { id } = await approvedMeeting();
    behaviour['sam@example.test'] = [new EmailSendError('Resend 401 validation_error: key re_SECRETabc123456 invalid', { retryable: false, publicMessage: 'The email service rejected the message' })];
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    await drain();
    const [[attempt]] = await pool.query('SELECT error FROM email_attempts WHERE success = FALSE');
    assert.ok(!attempt.error.includes('re_SECRET'));
    assert.match(attempt.error, /\[redacted\]/);
    const [[job]] = await pool.query("SELECT last_error FROM jobs WHERE status = 'failed'");
    assert.ok(!job.last_error.includes('re_SECRET'));
  });
});

describe('worker interruption', () => {
  it('recovers queued jobs after a crash and sends them', async () => {
    const { id } = await approvedMeeting();
    await A().post(`/api/v1/meetings/${id}/send-emails`);
    const claimed = await queue.claimNext('crashed-worker', ['email.send']);
    await pool.query('UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?', [claimed.id]);
    assert.deepEqual(await recover(handlers), { requeued: 1, dead: 0 });
    await drain();
    assert.ok((await msgs(id)).every((r) => r.status === 'sent'));
    assert.equal(sent.length, 2);
  });

  it('does not resend a message whose send was interrupted mid-flight; it is marked failed for an admin to decide', async () => {
    const { id } = await approvedMeeting();
    assert.equal((await A().post(`/api/v1/meetings/${id}/send-emails`)).status, 202);
    const claimed = await queue.claimNext('crashed-worker', ['email.send']);
    // The crashed worker had already moved the message to 'sending' (provider outcome unknown).
    await pool.query("UPDATE email_messages SET status = 'sending', attempt_count = 1 WHERE id = ?", [claimed.payload.messageId]);
    await pool.query('UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?', [claimed.id]);
    await recover(handlers);
    await drain();

    const row = (await pool.query('SELECT * FROM email_messages WHERE id = ?', [claimed.payload.messageId]))[0][0];
    assert.equal(row.status, 'failed');
    assert.match(row.last_error, /interrupted/);
    assert.equal(sent.filter((s) => s.to === row.recipient_email).length, 0);
  });
});
