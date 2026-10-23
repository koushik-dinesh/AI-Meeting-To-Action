// Admin review of action items: edit, assign, resolve flags, approve/reject/reopen, manual items,
// finishing the review. Items are seeded straight into MySQL (no Claude involved).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { applyEdit, approvalProblems, transition } from '../src/services/review.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let admin;
let employee;
let adminId;
let raj;
let sam;
let gone;

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin', fullName: 'Ada Admin' });
  await createUser({ email: 'emp@example.test', fullName: 'Eve Employee' });
  raj = await createUser({ email: 'raj@example.test', fullName: 'Raj Patel' });
  sam = await createUser({ email: 'sam@example.test', fullName: 'Sam Lee' });
  gone = await createUser({ email: 'gone@example.test', fullName: 'Gone User', isActive: false });
  admin = await loginCookie(app, 'admin@example.test');
  employee = await loginCookie(app, 'emp@example.test');
});
after(closeDatabase);

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
});
const A = () => as(admin);

let meetingId;
let runId;

async function seedItem(o = {}) {
  const [r] = await pool.query(
    `INSERT INTO action_items (meeting_id, extraction_run_id, title, description, assignee_name_raw, assignee_user_id, assignee_match,
       due_date, due_date_raw, priority, flags, review_details, ai_confidence, review_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meetingId, o.manual ? null : runId, o.title ?? 'Send the deck', 'desc', o.nameRaw ?? 'Sam', o.assignee ?? null, o.match ?? 'none',
      o.dueDate ?? null, o.dueRaw ?? 'next Friday', 'medium', JSON.stringify(o.flags ?? ['ambiguous_assignee', 'ambiguous_deadline']),
      JSON.stringify({ assignee: { candidates: [] } }), 0.9, o.status ?? 'pending',
    ],
  );
  await pool.query('INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec) VALUES (?, ?, ?, ?)', [r.insertId, 'I will send it', 'Sam', 12]);
  return r.insertId;
}
const row = async (id) => (await pool.query('SELECT * FROM action_items WHERE id = ?', [id]))[0][0];
const setMeetingStatus = (status) => pool.query('UPDATE meetings SET status = ? WHERE id = ?', [status, meetingId]);

beforeEach(async () => {
  await pool.query('DELETE FROM meetings');
  const [m] = await pool.query(
    "INSERT INTO meetings (title, meeting_url, status, created_by) VALUES ('Sync', 'https://meet.google.com/abc-defg-hij', 'review_pending', ?)",
    [adminId],
  );
  meetingId = m.insertId;
  const [r] = await pool.query("INSERT INTO extraction_runs (meeting_id, model, prompt_version, status) VALUES (?, 'm', 'v1', 'succeeded')", [meetingId]);
  runId = r.insertId;
});

describe('review rules (unit)', () => {
  const item = { title: 't', description: 'd', flags: ['ambiguous_assignee', 'ambiguous_deadline', 'low_confidence', 'missing_deadline'], reviewDetails: {}, assignee: null };

  it('resolves flags only through explicit edits', () => {
    const noop = applyEdit(item, { priority: 'high' }, { actorId: 1 });
    assert.deepEqual(noop.flags, item.flags);
    const assigned = applyEdit(item, { assigneeUserId: 5 }, { actorId: 1 });
    assert.deepEqual(assigned.flags, ['ambiguous_deadline', 'low_confidence', 'missing_deadline']);
    assert.equal(assigned.assigneeMatch, 'manual');
    assert.equal(assigned.reviewDetails.resolvedFlags[0].code, 'ambiguous_assignee');
    const dated = applyEdit(item, { dueDate: '2026-11-20', resolveFlags: ['low_confidence'] }, { actorId: 1 });
    assert.deepEqual(dated.flags, ['ambiguous_assignee']);
    assert.throws(() => applyEdit(item, { resolveFlags: ['deadline_conflict'] }, { actorId: 1 }), /not open/);
  });

  it('clearing the assignee or due date does not resolve anything', () => {
    const out = applyEdit(item, { assigneeUserId: null, dueDate: null }, { actorId: 1 });
    assert.deepEqual(out.flags, item.flags);
    assert.equal(out.assigneeMatch, 'none');
  });

  it('approval needs an active assignee and no blocking flags', () => {
    assert.deepEqual(approvalProblems({ flags: ['missing_deadline', 'merged_duplicates'], assignee: { isActive: true } }), []);
    assert.equal(approvalProblems({ flags: [], assignee: null })[0], 'Choose an assignee');
    assert.match(approvalProblems({ flags: [], assignee: { isActive: false, fullName: 'X' } })[0], /inactive/);
    assert.deepEqual(approvalProblems({ flags: ['low_confidence'], assignee: { isActive: true } }), ['Resolve the flag “AI is not confident this was an agreed action”']);
  });

  it('allows only valid status transitions', () => {
    assert.equal(transition('approve', 'pending'), 'approved');
    assert.equal(transition('reopen', 'rejected'), 'pending');
    assert.throws(() => transition('approve', 'approved'));
    assert.throws(() => transition('reject', 'rejected'));
    assert.throws(() => transition('reopen', 'pending'));
  });
});

describe('authorization', () => {
  it('blocks employees and anonymous users from every review endpoint', async () => {
    const id = await seedItem();
    const calls = [
      ['patch', `/api/v1/action-items/${id}`, { title: 'x' }],
      ['post', `/api/v1/action-items/${id}/approve`],
      ['post', `/api/v1/action-items/${id}/reject`],
      ['post', `/api/v1/action-items/${id}/reopen`],
      ['post', `/api/v1/meetings/${meetingId}/action-items`, { title: 'x' }],
      ['post', `/api/v1/meetings/${meetingId}/approve`],
    ];
    for (const [method, url, body] of calls) {
      assert.equal((await request(app)[method](url).send(body)).status, 401, url);
      assert.equal((await as(employee)[method](url, body)).status, 403, url);
    }
    assert.equal((await row(id)).title, 'Send the deck');
  });
});

describe('editing', () => {
  it('updates fields, assigns a user, resolves flags, and persists', async () => {
    const id = await seedItem();
    const res = await A().patch(`/api/v1/action-items/${id}`, {
      title: '  Send the final deck ',
      description: '',
      priority: 'high',
      assigneeUserId: sam,
      dueDate: '2026-11-13',
    });
    assert.equal(res.status, 200);
    const it = res.body.actionItem;
    assert.equal(it.title, 'Send the final deck');
    assert.equal(it.description, null);
    assert.equal(it.priority, 'high');
    assert.equal(it.assignee.id, sam);
    assert.equal(it.assigneeMatch, 'manual');
    assert.equal(it.dueDate, '2026-11-13');
    assert.equal(it.dueDateRaw, 'next Friday', 'original wording kept');
    assert.deepEqual(it.flags, []);
    assert.deepEqual(it.reviewDetails.resolvedFlags.map((r) => r.code).sort(), ['ambiguous_assignee', 'ambiguous_deadline']);
    assert.equal(it.evidence.length, 1);

    const list = await A().get(`/api/v1/meetings/${meetingId}/action-items`);
    assert.equal(list.body.actionItems[0].assignee.id, sam);

    const [audit] = await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'action_item' AND entity_id = ?", [id]);
    assert.deepEqual(audit.map((a) => a.action), ['action_item.updated']);
  });

  it('validates input', async () => {
    const id = await seedItem();
    const bad = await A().patch(`/api/v1/action-items/${id}`, { title: '', priority: 'urgent', dueDate: '2026-02-30', assigneeUserId: 'raj' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['assigneeUserId', 'dueDate', 'priority', 'title']);
    assert.equal((await A().patch(`/api/v1/action-items/${id}`, {})).status, 400);
    assert.equal((await A().patch(`/api/v1/action-items/${id}`, { reviewStatus: 'approved' })).status, 400);
    assert.equal((await A().patch(`/api/v1/action-items/${id}`, { resolveFlags: ['not_a_flag'] })).status, 400);
    const notOpen = await A().patch(`/api/v1/action-items/${id}`, { resolveFlags: ['low_confidence'] });
    assert.equal(notOpen.status, 400);
    assert.match(notOpen.body.error.message, /not open/);
  });

  it('only accepts active registered users as assignees', async () => {
    const id = await seedItem();
    for (const assigneeUserId of [gone, 999999]) {
      const res = await A().patch(`/api/v1/action-items/${id}`, { assigneeUserId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.details[0].field, 'assigneeUserId');
    }
    assert.equal((await A().patch(`/api/v1/action-items/${id}`, { assigneeUserId: 'jane@example.test' })).status, 400);
    assert.equal((await row(id)).assignee_user_id, null);
  });

  it('keeps flags when an ambiguous deadline is only cleared, and resolves them explicitly', async () => {
    const id = await seedItem({ flags: ['ambiguous_deadline'], assignee: raj, match: 'exact' });
    let res = await A().patch(`/api/v1/action-items/${id}`, { dueDate: null });
    assert.deepEqual(res.body.actionItem.flags, ['ambiguous_deadline']);
    res = await A().patch(`/api/v1/action-items/${id}`, { resolveFlags: ['ambiguous_deadline'] });
    assert.deepEqual(res.body.actionItem.flags, []);
    assert.equal(res.body.actionItem.dueDate, null);
  });

  it('404s for missing items and refuses edits to non-pending items', async () => {
    assert.equal((await A().patch('/api/v1/action-items/999999', { title: 'x' })).status, 404);
    const id = await seedItem({ status: 'approved', flags: [], assignee: raj });
    const res = await A().patch(`/api/v1/action-items/${id}`, { title: 'x' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ITEM_NOT_PENDING');
  });

  it('refuses changes while extraction runs or after the review is finished', async () => {
    const id = await seedItem();
    for (const status of ['extracting', 'approved']) {
      await setMeetingStatus(status);
      const res = await A().patch(`/api/v1/action-items/${id}`, { title: 'x' });
      assert.equal(res.status, 409, status);
      assert.equal(res.body.error.code, 'REVIEW_LOCKED');
    }
  });
});

describe('approve, reject, reopen', () => {
  it('refuses to approve an item with open flags or no assignee', async () => {
    const id = await seedItem();
    const res = await A().post(`/api/v1/action-items/${id}/approve`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOT_APPROVABLE');
    assert.deepEqual(res.body.error.details.map((d) => d.message), [
      'Choose an assignee',
      'Resolve the flag “Owner name matches several users”',
      'Resolve the flag “Deadline is vague or ambiguous”',
    ]);
    assert.equal((await row(id)).review_status, 'pending');
  });

  it('refuses to approve an item assigned to a now-inactive user', async () => {
    const id = await seedItem({ assignee: gone, flags: [] });
    const res = await A().post(`/api/v1/action-items/${id}/approve`);
    assert.equal(res.status, 409);
    assert.match(res.body.error.details[0].message, /inactive/);
  });

  it('approves a resolved item and records who approved it', async () => {
    const id = await seedItem({ assignee: raj, flags: ['missing_deadline'] });
    const res = await A().post(`/api/v1/action-items/${id}/approve`);
    assert.equal(res.status, 200);
    assert.equal(res.body.actionItem.reviewStatus, 'approved');
    const r = await row(id);
    assert.equal(r.approved_by, adminId);
    assert.ok(r.approved_at);
    const again = await A().post(`/api/v1/action-items/${id}/approve`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_TRANSITION');
  });

  it('rejects with an optional reason, and reopens', async () => {
    const id = await seedItem();
    const res = await A().post(`/api/v1/action-items/${id}/reject`, { reason: 'Just a suggestion' });
    assert.equal(res.status, 200);
    assert.equal(res.body.actionItem.reviewStatus, 'rejected');
    assert.equal(res.body.actionItem.reviewDetails.rejection.reason, 'Just a suggestion');
    assert.equal((await A().post(`/api/v1/action-items/${id}/reject`)).status, 409);
    assert.equal((await A().post(`/api/v1/action-items/${id}/approve`)).status, 409, 'rejected -> approved needs reopen');

    const reopened = await A().post(`/api/v1/action-items/${id}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.actionItem.reviewStatus, 'pending');
    assert.equal((await A().post(`/api/v1/action-items/${id}/reopen`)).status, 409);

    const [audit] = await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'action_item' AND entity_id = ? ORDER BY id", [id]);
    assert.deepEqual(audit.map((a) => a.action), ['action_item.rejected', 'action_item.reopened']);
  });

  it('rejects without a body and validates the reason', async () => {
    const id = await seedItem();
    assert.equal((await A().post(`/api/v1/action-items/${id}/reject`, { reason: 'x'.repeat(501) })).status, 400);
    assert.equal((await request(app).post(`/api/v1/action-items/${id}/reject`).set('Cookie', admin)).status, 200);
  });

  it('handles concurrent approvals of the same item safely', async () => {
    const id = await seedItem({ assignee: raj, flags: [] });
    const results = await Promise.all([1, 2, 3].map(() => A().post(`/api/v1/action-items/${id}/approve`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  });
});

describe('manual items', () => {
  it('creates a manual item without AI confidence or evidence', async () => {
    const res = await A().post(`/api/v1/meetings/${meetingId}/action-items`, { title: 'Book the venue', assigneeUserId: sam, dueDate: '2026-11-30' });
    assert.equal(res.status, 201);
    const it = res.body.actionItem;
    assert.equal(it.source, 'manual');
    assert.equal(it.aiConfidence, null);
    assert.deepEqual(it.evidence, []);
    assert.deepEqual(it.flags, []);
    assert.equal(it.priority, 'medium');
    assert.equal(it.assigneeMatch, 'manual');
    assert.equal(it.reviewStatus, 'pending');
    assert.equal((await A().post(`/api/v1/action-items/${it.id}/approve`)).status, 200);
  });

  it('validates manual items', async () => {
    const res = await A().post(`/api/v1/meetings/${meetingId}/action-items`, { title: '', priority: 'urgent', assigneeUserId: gone, aiConfidence: 1 });
    assert.equal(res.status, 400);
    assert.equal((await A().post(`/api/v1/meetings/${meetingId}/action-items`, { title: 'x', assigneeUserId: gone })).status, 400);
    assert.equal((await A().post('/api/v1/meetings/999999/action-items', { title: 'x' })).status, 404);
    await setMeetingStatus('extracting');
    assert.equal((await A().post(`/api/v1/meetings/${meetingId}/action-items`, { title: 'x' })).status, 409);
  });

  it('survives re-extraction (only pending AI items are replaced)', async () => {
    const res = await A().post(`/api/v1/meetings/${meetingId}/action-items`, { title: 'Manual task' });
    const { replacePendingExtracted } = await import('../src/repositories/actionItemsRepository.js');
    const conn = await pool.getConnection();
    try {
      await replacePendingExtracted(conn, meetingId, runId, []);
    } finally {
      conn.release();
    }
    assert.ok(await row(res.body.actionItem.id));
  });
});

describe('finishing the review', () => {
  it('lists what still needs attention and changes nothing', async () => {
    const blocked = await seedItem({ title: 'Ambiguous one' });
    await seedItem({ title: 'Ready one', assignee: raj, flags: [] });
    const res = await A().post(`/api/v1/meetings/${meetingId}/approve`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ITEMS_NEED_ATTENTION');
    assert.equal(res.body.error.details.length, 1);
    assert.equal(res.body.error.details[0].field, `actionItem:${blocked}`);
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM action_items WHERE meeting_id = ? AND review_status = 'approved'", [meetingId]);
    assert.equal(rows[0].n, 0, 'all-or-nothing');
  });

  it('approves all pending items, keeps rejections, and marks the meeting approved', async () => {
    const a = await seedItem({ assignee: raj, flags: [] });
    const b = await seedItem({ title: 'Other', assignee: sam, flags: ['missing_deadline'] });
    const c = await seedItem({ title: 'Nope' });
    await A().post(`/api/v1/action-items/${c}/reject`);

    const res = await A().post(`/api/v1/meetings/${meetingId}/approve`);
    assert.equal(res.status, 200);
    assert.equal(res.body.approved, 2);
    assert.equal((await row(a)).review_status, 'approved');
    assert.equal((await row(b)).review_status, 'approved');
    assert.equal((await row(c)).review_status, 'rejected');
    const [[m]] = await pool.query('SELECT status FROM meetings WHERE id = ?', [meetingId]);
    assert.equal(m.status, 'approved');

    // Locked afterwards, including extraction.
    assert.equal((await A().post(`/api/v1/action-items/${a}/reopen`)).body.error.code, 'REVIEW_LOCKED');
    assert.equal((await A().post(`/api/v1/meetings/${meetingId}/approve`)).status, 409);
    const [[audit]] = await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'meeting' AND entity_id = ?", [meetingId]);
    assert.equal(audit.action, 'meeting.review_completed');
  });

  it('refuses when there is nothing to review', async () => {
    const res = await A().post(`/api/v1/meetings/${meetingId}/approve`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOTHING_TO_APPROVE');
  });
});
