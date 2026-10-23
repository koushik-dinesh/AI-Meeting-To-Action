import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let admin;
let employee;
let janeId;
let rajId;
let inactiveId;

before(async () => {
  await resetDatabase();
  await createUser({ email: 'admin@example.test', role: 'admin' });
  await createUser({ email: 'emp@example.test', role: 'employee' });
  janeId = await createUser({ email: 'jane@example.test', fullName: 'Jane Liu' });
  rajId = await createUser({ email: 'raj@example.test', fullName: 'Raj Patel' });
  inactiveId = await createUser({ email: 'gone@example.test', isActive: false });
  admin = await loginCookie(app, 'admin@example.test');
  employee = await loginCookie(app, 'emp@example.test');
});
after(closeDatabase);

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
});

const MEET_URL = 'https://meet.google.com/abc-defg-hij';

describe('authorization', () => {
  it('rejects unauthenticated and employee access to meetings and transcripts', async () => {
    assert.equal((await request(app).get('/api/v1/meetings')).status, 401);
    const upload = await request(app)
      .post('/api/v1/meetings/1/transcript/upload')
      .send({ content: 'Jane: hi' });
    assert.equal(upload.status, 401);

    const e = as(employee);
    assert.equal((await e.get('/api/v1/meetings')).status, 403);
    assert.equal((await e.post('/api/v1/meetings', { title: 'x', meetingUrl: MEET_URL })).status, 403);
    assert.equal((await e.get('/api/v1/meetings/1/transcript')).status, 403);
    assert.equal((await e.post('/api/v1/meetings/1/transcript/upload', { content: 'Jane: hi' })).status, 403);
  });
});

describe('meetings', () => {
  let meetingId;

  it('creates a meeting with participants', async () => {
    const res = await as(admin).post('/api/v1/meetings', {
      title: '  Weekly sync ',
      meetingUrl: MEET_URL,
      scheduledAt: '2026-11-02T15:00:00+01:00',
      languageHint: 'en',
      participantIds: [janeId, rajId, janeId],
    });
    assert.equal(res.status, 201);
    const m = res.body.meeting;
    assert.equal(m.title, 'Weekly sync');
    assert.equal(m.status, 'draft');
    assert.equal(m.platform, null, 'platform is only set by the Vexa integration');
    assert.equal(new Date(m.scheduledAt).toISOString(), '2026-11-02T14:00:00.000Z');
    assert.deepEqual(m.participants.map((p) => p.fullName), ['Jane Liu', 'Raj Patel']);
    assert.equal(m.transcript, null);
    meetingId = m.id;
  });

  it('validates meeting input', async () => {
    const res = await as(admin).post('/api/v1/meetings', {
      title: '',
      meetingUrl: 'javascript:alert(1)',
      scheduledAt: 'tomorrow',
      languageHint: 'English',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(
      res.body.error.details.map((d) => d.field).sort(),
      ['languageHint', 'meetingUrl', 'scheduledAt', 'title'],
    );
  });

  it('rejects unknown or inactive participants', async () => {
    const res = await as(admin).post('/api/v1/meetings', {
      title: 'Bad participants',
      meetingUrl: MEET_URL,
      participantIds: [janeId, inactiveId, 999999],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.length, 2);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM meetings WHERE title = 'Bad participants'");
    assert.equal(n, 0);
  });

  it('gets a meeting and 404s for unknown ids', async () => {
    const res = await as(admin).get(`/api/v1/meetings/${meetingId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.meeting.participants.length, 2);
    assert.equal((await as(admin).get('/api/v1/meetings/999999')).status, 404);
    assert.equal((await as(admin).get('/api/v1/meetings/0')).status, 400);
  });

  it('updates fields and replaces participants', async () => {
    const res = await as(admin).patch(`/api/v1/meetings/${meetingId}`, {
      title: 'Weekly sync (moved)',
      scheduledAt: null,
      participantIds: [rajId],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.meeting.title, 'Weekly sync (moved)');
    assert.equal(res.body.meeting.scheduledAt, null);
    assert.deepEqual(res.body.meeting.participants.map((p) => p.id), [rajId]);

    assert.equal((await as(admin).patch(`/api/v1/meetings/${meetingId}`, { status: 'approved' })).status, 400);
  });

  it('lists meetings with filters and pagination', async () => {
    await as(admin).post('/api/v1/meetings', { title: 'Retro', meetingUrl: MEET_URL });
    const all = await as(admin).get('/api/v1/meetings');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.equal(all.body.meetings[0].participantCount !== undefined, true);

    const byTitle = await as(admin).get('/api/v1/meetings?q=retro');
    assert.deepEqual(byTitle.body.meetings.map((m) => m.title), ['Retro']);

    const paged = await as(admin).get('/api/v1/meetings?limit=1&offset=1');
    assert.equal(paged.body.meetings.length, 1);
    assert.equal(paged.body.total, 2);

    assert.equal((await as(admin).get('/api/v1/meetings?status=nope')).status, 400);
    assert.equal((await as(admin).get('/api/v1/meetings?limit=1000')).status, 400);
  });

  it('writes audit entries', async () => {
    const [rows] = await pool.query(
      "SELECT action FROM audit_logs WHERE entity_type = 'meeting' AND entity_id = ? ORDER BY id",
      [meetingId],
    );
    assert.deepEqual(rows.map((r) => r.action), ['meeting.created', 'meeting.updated']);
  });
});

describe('transcripts', () => {
  let meetingId;
  const upload = (body, id = meetingId) => as(admin).post(`/api/v1/meetings/${id}/transcript/upload`, body);

  before(async () => {
    const res = await as(admin).post('/api/v1/meetings', { title: 'Transcript test', meetingUrl: MEET_URL });
    meetingId = res.body.meeting.id;
  });

  it('404s before a transcript exists', async () => {
    const res = await as(admin).get(`/api/v1/meetings/${meetingId}/transcript`);
    assert.equal(res.status, 404);
  });

  it('accepts pasted text and stores segments with speakers and timestamps', async () => {
    const res = await upload({ content: '[00:12] Jane Liu: I will send the deck by Friday.\n[01:05] Raj: Thanks.\nAlso the budget.' });
    assert.equal(res.status, 201);
    assert.equal(res.body.transcript.format, 'text');
    assert.equal(res.body.transcript.filename, null);
    assert.equal(res.body.transcript.segmentCount, 2);
    assert.equal(res.body.meeting.status, 'transcript_ready');

    const got = await as(admin).get(`/api/v1/meetings/${meetingId}/transcript`);
    assert.equal(got.status, 200);
    assert.deepEqual(
      got.body.segments.map((s) => [s.startSec, s.speaker, s.text]),
      [
        [12, 'Jane Liu', 'I will send the deck by Friday.'],
        [65, 'Raj', 'Thanks. Also the budget.'],
      ],
    );

    const [[t]] = await pool.query('SELECT full_text, raw_json FROM transcripts WHERE meeting_id = ?', [meetingId]);
    assert.match(t.full_text, /^\[00:12\] Jane Liu: I will send/);
    assert.equal(t.raw_json.source, 'manual_upload');
    assert.match(t.raw_json.content, /Also the budget/);
  });

  it('replaces the transcript on re-upload (VTT file)', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Jane Liu>Replaced</v>\n';
    const res = await upload({ content: vtt, filename: 'call.vtt' });
    assert.equal(res.status, 201);
    assert.equal(res.body.transcript.format, 'vtt');
    assert.equal(res.body.transcript.filename, 'call.vtt');

    const got = await as(admin).get(`/api/v1/meetings/${meetingId}/transcript`);
    assert.deepEqual(got.body.segments.map((s) => [s.startSec, s.endSec, s.speaker, s.text]), [[1, 3, 'Jane Liu', 'Replaced']]);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?', [meetingId]);
    assert.equal(n, 1);
  });

  it('accepts Vexa-shaped JSON and records detected languages', async () => {
    const json = JSON.stringify({
      segments: [
        { segment_id: 'a', speaker: 'Jane Liu', text: 'Hola', start: 1, end: 2, language: 'es', completed: true, confidence: 0.9 },
        { segment_id: 'b', speaker: '', text: 'Hello', start: 3, end: 4, language: 'en', completed: true },
      ],
    });
    const res = await upload({ content: json, filename: 'vexa.json' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.transcript.detectedLanguages.sort(), ['en', 'es']);
    const got = await as(admin).get(`/api/v1/meetings/${meetingId}/transcript`);
    assert.deepEqual(got.body.segments.map((s) => [s.sourceId, s.speaker, s.confidence]), [['a', 'Jane Liu', 0.9], ['b', null, null]]);
  });

  it('shows the transcript summary on the meeting detail', async () => {
    const res = await as(admin).get(`/api/v1/meetings/${meetingId}`);
    assert.equal(res.body.meeting.status, 'transcript_ready');
    assert.equal(res.body.meeting.transcript.segmentCount, 2);
  });

  it('enforces file type, size, content and format rules', async () => {
    assert.equal((await upload({ content: 'x', filename: 'evil.exe' })).status, 415);
    assert.equal((await upload({ content: 'x', filename: 'notes.docx' })).status, 415);
    assert.equal((await upload({ content: 'MZ\u0000\u0000binary' })).status, 415);
    assert.equal((await upload({ content: '' })).status, 400);
    assert.equal((await upload({ content: '   \n  ' })).status, 400);
    assert.equal((await upload({ content: '{bad', format: 'vexa_json' })).status, 400);
    assert.equal((await upload({ content: 'x', format: 'docx' })).status, 400);

    const big = 'Jane: ' + 'a'.repeat(2 * 1024 * 1024);
    assert.equal((await upload({ content: big })).status, 413);
  });

  it('rejects oversized bodies on other routes (100 KB app limit still applies)', async () => {
    const res = await as(admin).post('/api/v1/meetings', { title: 'x'.repeat(200 * 1024), meetingUrl: MEET_URL });
    assert.equal(res.status, 413);
  });

  it('404s for unknown meetings and 409s once extraction has started', async () => {
    assert.equal((await upload({ content: 'Jane: hi' }, 999999)).status, 404);
    await pool.query("UPDATE meetings SET status = 'review_pending' WHERE id = ?", [meetingId]);
    const res = await upload({ content: 'Jane: too late' });
    assert.equal(res.status, 409);
    const got = await as(admin).get(`/api/v1/meetings/${meetingId}/transcript`);
    assert.equal(got.body.segments[0].text, 'Hola', 'existing transcript untouched');
  });
});
