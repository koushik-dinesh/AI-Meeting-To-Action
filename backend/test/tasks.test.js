// Employee task portal: ownership scoping, status workflow, audit consistency.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { canTransition, isOverdue, summarize } from '../src/services/tasks.js';
import { addDays, localDate } from '../src/utils/dates.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let adminId;
let ana;
let ben;
let admin;
let anaCookie;
let benCookie;
const today = localDate(new Date(), 'UTC'); // MEETING_TIMEZONE defaults to UTC

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin' });
  ana = await createUser({ email: 'ana@example.test', fullName: 'Ana Garcia' });
  ben = await createUser({ email: 'ben@example.test', fullName: 'Ben Okafor' });
  admin = await loginCookie(app, 'admin@example.test');
  anaCookie = await loginCookie(app, 'ana@example.test');
  benCookie = await loginCookie(app, 'ben@example.test');
});
after(closeDatabase);

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
});

let items;
async function meeting(status, title) {
  const [m] = await pool.query("INSERT INTO meetings (title, meeting_url, status, scheduled_at, created_by) VALUES (?, 'https://meet.google.com/abc-defg-hij', ?, '2026-11-04 10:00:00', ?)", [title, status, adminId]);
  return m.insertId;
}
async function item(meetingId, title, assignee, { review = 'approved', task = 'todo', due = null, priority = 'medium' } = {}) {
  const [r] = await pool.query(
    `INSERT INTO action_items (meeting_id, title, description, assignee_user_id, assignee_match, due_date, priority, review_status, task_status, flags, review_details, ai_confidence)
     VALUES (?, ?, 'Do the thing', ?, 'exact', ?, ?, ?, ?, '["assignee_first_name_only"]', '{"aiNote":"internal"}', 0.9)`,
    [meetingId, title, assignee, due, priority, review, task],
  );
  return r.insertId;
}

beforeEach(async () => {
  await pool.query('DELETE FROM meetings');
  await pool.query("DELETE FROM audit_logs WHERE action = 'task.status_changed'");
  const done = await meeting('emails_sent', 'Launch sync');
  const approvedOnly = await meeting('approved', 'Retro');
  const inReview = await meeting('review_pending', 'Planning');
  items = {
    anaOverdue: await item(done, 'Send the deck', ana, { due: addDays(today, -2), priority: 'high' }),
    anaFuture: await item(done, 'Book the venue', ana, { due: addDays(today, 10), task: 'in_progress' }),
    anaDoneLate: await item(approvedOnly, 'Write notes', ana, { due: addDays(today, -5), task: 'done', priority: 'low' }),
    anaRejected: await item(done, 'Rejected idea', ana, { review: 'rejected' }),
    anaPending: await item(done, 'Still pending', ana, { review: 'pending' }),
    anaUnfinishedReview: await item(inReview, 'Approved but meeting in review', ana),
    ben: await item(done, 'Ben task', ben),
  };
  const [e] = await pool.query(
    "INSERT INTO email_messages (meeting_id, recipient_user_id, recipient_email, subject, html_body, text_body, idempotency_key, status, sent_at) VALUES (?, ?, 'ana@example.test', 's', 'h', 't', ?, 'sent', NOW())",
    [done, ana, 'k'.repeat(64)],
  );
  await pool.query('INSERT INTO email_message_items VALUES (?, ?)', [e.insertId, items.anaOverdue]);
  await pool.query("INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec) VALUES (?, 'I will send the deck', 'Ana', 20)", [items.anaOverdue]);
  await pool.query('UPDATE action_items SET approved_at = NOW() WHERE review_status = ?', ['approved']);
});

describe('rules (unit)', () => {
  it('allows the planned transitions and refuses no-ops', () => {
    assert.ok(canTransition('todo', 'in_progress'));
    assert.ok(canTransition('in_progress', 'done'));
    assert.ok(canTransition('in_progress', 'blocked'));
    assert.ok(canTransition('done', 'in_progress'), 'reopen');
    assert.ok(!canTransition('done', 'done'));
    assert.ok(!canTransition('todo', 'todo'));
    assert.ok(!canTransition('done', 'blocked'));
  });

  it('counts overdue only for open tasks with a past due date', () => {
    const t = (taskStatus, dueDate) => ({ taskStatus, dueDate });
    assert.ok(isOverdue(t('todo', '2026-01-01'), '2026-01-02'));
    assert.ok(!isOverdue(t('todo', '2026-01-02'), '2026-01-02'), 'due today is not overdue');
    assert.ok(!isOverdue(t('done', '2026-01-01'), '2026-01-02'));
    assert.ok(!isOverdue(t('todo', null), '2026-01-02'));
    assert.deepEqual(summarize([t('todo', '2026-01-01'), t('done', null), t('blocked', null)], '2026-01-02'), { total: 3, todo: 1, inProgress: 0, blocked: 1, done: 1, overdue: 1 });
  });
});

describe('authorization', () => {
  it('requires a session', async () => {
    assert.equal((await request(app).get('/api/v1/me/tasks')).status, 401);
    assert.equal((await request(app).get(`/api/v1/me/tasks/${items.anaOverdue}`)).status, 401);
    assert.equal((await request(app).patch(`/api/v1/me/tasks/${items.anaOverdue}/status`).send({ status: 'done' })).status, 401);
  });

  it('keeps employees out of admin review endpoints', async () => {
    const e = as(anaCookie);
    assert.equal((await e.post(`/api/v1/action-items/${items.anaOverdue}/approve`)).status, 403);
    assert.equal((await e.post(`/api/v1/action-items/${items.anaOverdue}/reject`)).status, 403);
    assert.equal((await e.patch(`/api/v1/action-items/${items.anaOverdue}`, { title: 'x' })).status, 403);
    assert.equal((await e.get('/api/v1/meetings')).status, 403);
  });
});

describe('listing', () => {
  it('returns only the caller’s approved tasks from finished reviews, with a summary', async () => {
    const res = await as(anaCookie).get('/api/v1/me/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tasks.map((t) => t.title).sort(), ['Book the venue', 'Send the deck', 'Write notes']);
    assert.deepEqual(res.body.summary, { total: 3, todo: 1, inProgress: 1, blocked: 0, done: 1, overdue: 1 });
    assert.equal(res.body.today, today);

    const deck = res.body.tasks.find((t) => t.title === 'Send the deck');
    assert.equal(deck.overdue, true);
    assert.equal(deck.meeting.title, 'Launch sync');
    assert.deepEqual(deck.allowedStatuses, ['in_progress', 'blocked', 'done']);
    assert.equal(res.body.tasks.find((t) => t.title === 'Write notes').overdue, false, 'done tasks are never overdue');

    // No admin-only or other people's data.
    const json = JSON.stringify(res.body);
    for (const leak of ['flags', 'reviewDetails', 'aiConfidence', 'assignee', 'internal', 'ben@example.test', 'Ben task']) {
      assert.ok(!json.includes(leak), leak);
    }
  });

  it('filters by status and validates the filter', async () => {
    const res = await as(anaCookie).get('/api/v1/me/tasks?status=in_progress');
    assert.deepEqual(res.body.tasks.map((t) => t.title), ['Book the venue']);
    assert.equal(res.body.summary.total, 3, 'summary covers all tasks');
    assert.equal((await as(anaCookie).get('/api/v1/me/tasks?status=approved')).status, 400);
  });

  it('ignores any user id supplied by the browser', async () => {
    const res = await as(benCookie).get(`/api/v1/me/tasks?userId=${ana}`);
    assert.equal(res.status, 400, 'unknown query parameters are rejected');
    const own = await as(benCookie).get('/api/v1/me/tasks');
    assert.deepEqual(own.body.tasks.map((t) => t.title), ['Ben task']);
  });
});

describe('details', () => {
  it('includes meeting context, evidence and history', async () => {
    const res = await as(anaCookie).get(`/api/v1/me/tasks/${items.anaOverdue}`);
    assert.equal(res.status, 200);
    const t = res.body.task;
    assert.equal(t.meeting.title, 'Launch sync');
    assert.deepEqual(t.evidence, [{ excerpt: 'I will send the deck', speaker: 'Ana', startSec: 20 }]);
    assert.deepEqual(t.history.map((h) => h.type), ['approved', 'emailed']);
  });

  it('returns the same 404 for missing, foreign, rejected, pending and unfinished-review tasks', async () => {
    for (const id of [999999, items.ben, items.anaRejected, items.anaPending, items.anaUnfinishedReview]) {
      const res = await as(anaCookie).get(`/api/v1/me/tasks/${id}`);
      assert.equal(res.status, 404, String(id));
      assert.equal(res.body.error.message, 'Task not found');
    }
    assert.equal((await as(anaCookie).get('/api/v1/me/tasks/abc')).status, 400);
  });
});

describe('status updates', () => {
  const update = (cookie, id, body) => as(cookie).patch(`/api/v1/me/tasks/${id}/status`, body);
  const row = async (id) => (await pool.query('SELECT task_status, review_status, title, priority, due_date FROM action_items WHERE id = ?', [id]))[0][0];

  it('moves a task through the workflow, persists it, and audits each change atomically', async () => {
    let res = await update(anaCookie, items.anaOverdue, { status: 'in_progress', fromStatus: 'todo' });
    assert.equal(res.status, 200);
    assert.equal(res.body.task.taskStatus, 'in_progress');
    res = await update(anaCookie, items.anaOverdue, { status: 'done' });
    assert.equal(res.body.task.taskStatus, 'done');
    assert.equal(res.body.task.overdue, false);
    res = await update(anaCookie, items.anaOverdue, { status: 'in_progress' });
    assert.equal(res.body.task.taskStatus, 'in_progress', 'reopen');

    const r = await row(items.anaOverdue);
    assert.equal(r.task_status, 'in_progress');
    assert.equal(r.review_status, 'approved', 'review status untouched');

    const [audit] = await pool.query("SELECT actor_user_id, before_json, after_json, created_at FROM audit_logs WHERE action = 'task.status_changed' AND entity_id = ? ORDER BY id", [items.anaOverdue]);
    assert.deepEqual(audit.map((a) => [a.actor_user_id, a.before_json.taskStatus, a.after_json.taskStatus]), [
      [ana, 'todo', 'in_progress'],
      [ana, 'in_progress', 'done'],
      [ana, 'done', 'in_progress'],
    ]);
    assert.ok(audit.every((a) => a.created_at));

    const detail = await as(anaCookie).get(`/api/v1/me/tasks/${items.anaOverdue}`);
    assert.deepEqual(detail.body.task.history.filter((h) => h.type === 'status_changed').map((h) => [h.from, h.to, h.by]), [
      ['todo', 'in_progress', 'Ana Garcia'],
      ['in_progress', 'done', 'Ana Garcia'],
      ['done', 'in_progress', 'Ana Garcia'],
    ]);
  });

  it('refuses invalid transitions and stale updates without writing anything', async () => {
    let res = await update(anaCookie, items.anaOverdue, { status: 'todo' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INVALID_TRANSITION');
    res = await update(anaCookie, items.anaDoneLate, { status: 'blocked' });
    assert.equal(res.body.error.code, 'INVALID_TRANSITION');
    res = await update(anaCookie, items.anaFuture, { status: 'done', fromStatus: 'todo' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_STATUS');
    assert.equal((await row(items.anaFuture)).task_status, 'in_progress');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.status_changed'");
    assert.equal(n, 0);
  });

  it('a repeated identical submission changes the task once', async () => {
    const body = { status: 'done', fromStatus: 'todo' };
    const results = await Promise.all([update(anaCookie, items.anaOverdue, body), update(anaCookie, items.anaOverdue, body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.status_changed'");
    assert.equal(n, 1);
  });

  it('cannot touch other people’s, rejected, pending or unfinished-review tasks', async () => {
    for (const id of [items.ben, items.anaRejected, items.anaPending, items.anaUnfinishedReview, 999999]) {
      const res = await update(anaCookie, id, { status: 'done' });
      assert.equal(res.status, 404, String(id));
    }
    assert.equal((await row(items.ben)).task_status, 'todo');
    assert.equal((await row(items.anaRejected)).task_status, 'todo');
  });

  it('accepts only a valid status and no other fields', async () => {
    for (const body of [{}, { status: 'approved' }, { status: 'finished' }, { status: 'done', title: 'Renamed' }, { status: 'done', priority: 'high' }, { status: 'done', assigneeUserId: ben }, { status: 'done', dueDate: '2030-01-01' }]) {
      const res = await update(anaCookie, items.anaOverdue, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const r = await row(items.anaOverdue);
    assert.equal(r.title, 'Send the deck');
    assert.equal(r.priority, 'high');
    assert.equal(r.task_status, 'todo');
  });

  it('lets the admin see employee progress', async () => {
    await update(anaCookie, items.anaOverdue, { status: 'blocked' });
    const [[m]] = await pool.query('SELECT meeting_id FROM action_items WHERE id = ?', [items.anaOverdue]);
    const res = await as(admin).get(`/api/v1/meetings/${m.meeting_id}/action-items`);
    assert.equal(res.body.actionItems.find((i) => i.id === items.anaOverdue).taskStatus, 'blocked');
  });
});
