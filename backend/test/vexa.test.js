// Vexa meeting-bot integration: API -> Vexa client -> jobs -> worker -> transcript -> extraction.
// Vexa is a fake HTTP service (vexa.fetch is replaced); nothing here calls a real Vexa or Google Meet.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { handlers } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext, recover } from '../src/jobs/runner.js';
import { claude } from '../src/services/ai/claudeClient.js';
import { importTranscript } from '../src/services/meetingBot.js';
import { vexa } from '../src/services/vexa/client.js';
import { parseGoogleMeetUrl, toMeetingStatus } from '../src/services/vexa/mapper.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const originalVexa = { ...vexa, settings: { ...vexa.settings } };
const originalClaude = { ...claude };
const originalCfg = { ...config.vexa };
const MEET = 'https://meet.google.com/abc-defg-hij';

let admins;
let employee;
let adminId;
let turn = 0;
const A = () => {
  const cookie = admins[turn++ % admins.length];
  return {
    get: (url) => request(app).get(url).set('Cookie', cookie),
    post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
    del: (url) => request(app).delete(url).set('Cookie', cookie),
  };
};

// ---------- fake Vexa ----------
let calls; // [{ method, path, body, headers }]
let remote; // the Vexa meeting as Vexa sees it
let scripted; // 'METHOD /path' -> array of { status, body, headers } | Error, consumed first
const json = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const vexaMeeting = () => ({ id: remote.id, user_id: 1, platform: 'google_meet', native_meeting_id: 'abc-defg-hij', status: remote.status, bot_container_id: null, start_time: remote.startTime, end_time: null, completion_reason: remote.reason ?? null, created_at: '2026-10-22T10:00:00Z', updated_at: '2026-10-22T10:00:00Z' });

async function fakeFetch(url, init) {
  const u = new URL(url);
  const key = `${init.method} ${u.pathname}`;
  calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
  const next = scripted[key]?.shift();
  if (next instanceof Error) throw next;
  if (next) return json(next.status, next.body, next.headers);
  if (key === 'POST /bots') return json(201, vexaMeeting());
  if (key === `GET /meetings/${remote.id}`) return json(200, vexaMeeting());
  if (key === 'GET /transcripts/google_meet/abc-defg-hij') return json(200, { ...vexaMeeting(), constructed_meeting_url: MEET, recordings: [], segments: remote.segments });
  if (key === 'DELETE /bots/google_meet/abc-defg-hij') return json(200, { status: 'stopping' });
  return json(404, { detail: 'not found' });
}

const SEGMENTS = [
  { segment_id: 'v1', speaker: 'Jane Liu', text: 'I will send the deck by Friday.', start: 12.4, end: 15.1, language: 'en', completed: true, absolute_start_time: '2026-10-22T10:00:12Z' },
  { segment_id: 'v2', speaker: '', text: 'Ich übernehme die Übersetzung.', start: 16, end: 18, language: 'de', completed: true },
  { segment_id: 'v3', speaker: 'Jane Liu', text: 'draft that was replaced', start: 19, end: 20, language: 'en', completed: false },
];

// ---------- helpers ----------
// Poll ticks run only the poller; queued ai.extract jobs are asserted on, not executed, here.
const work = () => processNext('test-worker', { 'vexa.poll': handlers['vexa.poll'] });
const makeDue = () => pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
const tick = async () => {
  await makeDue();
  return work();
};
const meetingRow = async (id) => (await pool.query('SELECT * FROM meetings WHERE id = ?', [id]))[0][0];
const pollJob = async (id) => (await pool.query("SELECT * FROM jobs WHERE type = 'vexa.poll' AND JSON_EXTRACT(payload, '$.meetingId') = ? ORDER BY id DESC LIMIT 1", [id]))[0][0];
const extractJobs = async (id) => (await pool.query("SELECT * FROM jobs WHERE type = 'ai.extract' AND JSON_EXTRACT(payload, '$.meetingId') = ?", [id]))[0];
const auditActions = async (id) => (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'meeting' AND entity_id = ? ORDER BY id", [id]))[0].map((r) => r.action);

async function newMeeting(url = MEET) {
  const res = await A().post('/api/v1/meetings', { title: 'Bot sync', meetingUrl: url, scheduledAt: new Date().toISOString() });
  assert.equal(res.status, 201);
  return res.body.meeting.id;
}
async function requestedMeeting() {
  const id = await newMeeting();
  const res = await A().post(`/api/v1/meetings/${id}/bot`);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  return id;
}

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin' });
  for (const n of [2, 3, 4, 5, 6]) await createUser({ email: `admin${n}@example.test`, role: 'admin' });
  await createUser({ email: 'emp@example.test' });
  admins = [await loginCookie(app, 'admin@example.test')];
  for (const n of [2, 3, 4, 5, 6]) admins.push(await loginCookie(app, `admin${n}@example.test`));
  employee = await loginCookie(app, 'emp@example.test');
});
beforeEach(async () => {
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM jobs');
  calls = [];
  scripted = {};
  remote = { id: 501, status: 'requested', startTime: new Date(Date.now() + 1000).toISOString(), segments: [] };
  vexa.settings.baseUrl = 'http://vexa.test';
  vexa.settings.apiKey = 'test-vexa-key';
  vexa.fetch = fakeFetch;
  claude.isConfigured = () => true;
  Object.assign(config.vexa, originalCfg, { pollIntervalMs: 15_000, transcriptWaitMs: 5 * 60_000 });
});
afterEach(() => {
  Object.assign(vexa, { fetch: originalVexa.fetch });
  Object.assign(vexa.settings, originalVexa.settings);
  Object.assign(claude, originalClaude);
  Object.assign(config.vexa, originalCfg);
});
after(closeDatabase);

// ---------- tests ----------

describe('mapper (unit)', () => {
  it('accepts only real Google Meet links', () => {
    assert.deepEqual(parseGoogleMeetUrl('https://meet.google.com/abc-defg-hij'), { platform: 'google_meet', nativeMeetingId: 'abc-defg-hij' });
    assert.deepEqual(parseGoogleMeetUrl('https://meet.google.com/abc-defg-hij/?authuser=0#x'), { platform: 'google_meet', nativeMeetingId: 'abc-defg-hij' });
    for (const bad of [
      'http://meet.google.com/abc-defg-hij',
      'https://meet.google.com.evil.example/abc-defg-hij',
      'https://evil.example/meet.google.com/abc-defg-hij',
      'https://meet.google.com/lookup/abcdefg',
      'https://meet.google.com/abc-defg-hij/extra',
      'https://meet.google.com:8443/abc-defg-hij',
      'https://user@meet.google.com/abc-defg-hij',
      'https://meet.google.com/ABC-DEFG-HIJ',
      'https://zoom.us/j/123456789',
      'not a url',
    ]) {
      assert.equal(parseGoogleMeetUrl(bad), null, bad);
    }
  });

  it('maps Vexa statuses without treating the lobby as a failure', () => {
    assert.equal(toMeetingStatus('requested'), 'bot_requested');
    assert.equal(toMeetingStatus('awaiting_admission'), 'bot_joining');
    assert.equal(toMeetingStatus('needs_human_help'), 'bot_joining');
    assert.equal(toMeetingStatus('active'), 'in_progress');
    assert.equal(toMeetingStatus('stopping'), 'in_progress');
    assert.equal(toMeetingStatus('completed'), 'ended');
    assert.equal(toMeetingStatus('failed'), 'failed');
    assert.equal(toMeetingStatus('weird'), null);
  });
});

describe('authorization and configuration', () => {
  it('is admin-only', async () => {
    const id = await newMeeting();
    for (const [method, url] of [
      ['get', `/api/v1/meetings/${id}/bot`],
      ['post', `/api/v1/meetings/${id}/bot`],
      ['delete', `/api/v1/meetings/${id}/bot`],
      ['post', `/api/v1/meetings/${id}/bot/check`],
      ['post', `/api/v1/meetings/${id}/transcript/refresh`],
    ]) {
      assert.equal((await request(app)[method](url)).status, 401, url);
      assert.equal((await request(app)[method](url).set('Cookie', employee)).status, 403, url);
    }
    assert.equal(calls.length, 0);
  });

  it('reports missing Vexa configuration without calling anything', async () => {
    vexa.settings.apiKey = undefined;
    const id = await newMeeting();
    const view = await A().get(`/api/v1/meetings/${id}/bot`);
    assert.equal(view.body.bot.configured, false);
    assert.equal(view.body.bot.canRequest, false);
    const res = await A().post(`/api/v1/meetings/${id}/bot`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'VEXA_NOT_CONFIGURED');
    assert.equal((await meetingRow(id)).status, 'draft');
    assert.equal(calls.length, 0);
  });

  it('refuses invalid meeting links', async () => {
    const id = await newMeeting('https://meet.google.com.evil.example/abc-defg-hij');
    const res = await A().post(`/api/v1/meetings/${id}/bot`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_MEETING_URL');
    assert.equal((await A().get(`/api/v1/meetings/${id}/bot`)).body.bot.linkValid, false);
    assert.equal(calls.length, 0);
  });
});

describe('requesting a bot', () => {
  it('sends the documented request with the API key and starts polling', async () => {
    const id = await requestedMeeting();
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.path, '/bots');
    assert.deepEqual(post.body, { platform: 'google_meet', native_meeting_id: 'abc-defg-hij', bot_name: 'Meeting to Action' });
    assert.equal(post.headers['X-API-Key'], 'test-vexa-key');

    const m = await meetingRow(id);
    assert.deepEqual([m.status, m.platform, m.native_meeting_id, m.vexa_meeting_id, m.bot_status], ['bot_requested', 'google_meet', 'abc-defg-hij', '501', 'requested']);
    const job = await pollJob(id);
    assert.equal(job.status, 'pending');
    assert.ok(new Date(job.run_at) > new Date(Date.now() + 5000), 'first poll is delayed');
    assert.deepEqual(await auditActions(id), ['meeting.created', 'bot.requested']);

    const view = await A().get(`/api/v1/meetings/${id}/bot`);
    assert.equal(view.body.bot.bot.status, 'requested');
    assert.equal(view.body.bot.canRequest, false);
    assert.equal(JSON.stringify(view.body).includes('test-vexa-key'), false, 'API key never reaches the browser');
  });

  it('copes with an untyped POST /bots body (no id) and ignores invalid fields', async () => {
    scripted['POST /bots'] = [{ status: 201, body: { id: 'not-a-number', status: 'teleporting' } }];
    const id = await requestedMeeting();
    const m = await meetingRow(id);
    assert.equal(m.vexa_meeting_id, null);
    assert.equal(m.bot_status, 'requested');
  });

  it('refuses duplicate and concurrent requests; Vexa is called once', async () => {
    const id = await newMeeting();
    const results = await Promise.all([1, 2, 3].map(() => A().post(`/api/v1/meetings/${id}/bot`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 409, 409]);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    const again = await A().post(`/api/v1/meetings/${id}/bot`);
    assert.equal(again.body.error.code, 'BOT_ALREADY_ACTIVE');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE type = 'vexa.poll'");
    assert.equal(n, 1);
  });

  it('refuses a second meeting with a live bot on the same link', async () => {
    await requestedMeeting();
    const other = await newMeeting();
    const res = await A().post(`/api/v1/meetings/${other}/bot`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LINK_IN_USE');
  });

  it('maps Vexa errors and undoes the claim', async () => {
    const cases = [
      [{ status: 401, body: { detail: 'Invalid API key' } }, 502, 'VEXA_AUTH'],
      [{ status: 422, body: { detail: [{ msg: 'native_meeting_id missing' }] } }, 400, 'VEXA_VALIDATION'],
      [{ status: 429, body: { detail: 'slow down' }, headers: { 'retry-after': '3' } }, 503, 'VEXA_RATE_LIMITED'],
      [{ status: 503, body: { detail: 'TRANSCRIPTION_SERVICE_URL not set' } }, 503, 'VEXA_UNAVAILABLE'],
      [new TypeError('fetch failed'), 502, 'VEXA_NETWORK'],
      [{ status: 201, body: '<html>oops' }, 502, 'VEXA_INVALID_RESPONSE'],
    ];
    for (const [reply, status, code] of cases) {
      const id = await newMeeting();
      scripted['POST /bots'] = [reply];
      const res = await A().post(`/api/v1/meetings/${id}/bot`);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error.code, code);
      const m = await meetingRow(id);
      assert.equal(m.status, 'draft', code);
      assert.ok(m.last_error, code);
      assert.equal(await pollJob(id), undefined, code);
      await pool.query('DELETE FROM meetings WHERE id = ?', [id]);
    }
    assert.ok((await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'bot.request_failed'"))[0][0].n >= 6);
  });

  it('treats Vexa 409 (bot already on the link) as running and tracks it', async () => {
    scripted['POST /bots'] = [{ status: 409, body: { detail: 'Bot already active' } }];
    const id = await requestedMeeting();
    assert.equal((await meetingRow(id)).status, 'bot_requested');
    assert.equal((await pollJob(id)).status, 'pending');
  });
});

describe('polling', () => {
  it('follows joining -> lobby -> active -> completed, imports the transcript and queues extraction', async () => {
    const id = await requestedMeeting();
    remote.status = 'joining';
    await tick();
    assert.equal((await meetingRow(id)).status, 'bot_joining');

    remote.status = 'awaiting_admission';
    await tick();
    let m = await meetingRow(id);
    assert.deepEqual([m.status, m.bot_status, m.last_error], ['bot_joining', 'awaiting_admission', null], 'lobby is not a failure');
    assert.equal((await pollJob(id)).attempts, 0, 'rescheduling does not use attempts');

    remote.status = 'active';
    await tick();
    m = await meetingRow(id);
    assert.equal(m.status, 'in_progress');
    assert.ok(m.started_at);
    assert.equal((await A().post(`/api/v1/meetings/${id}/transcript/upload`, { content: 'Jane: hi' })).status, 409, 'no manual upload while the bot is live');

    remote.status = 'completed';
    remote.reason = 'left_alone';
    remote.segments = SEGMENTS;
    await tick();

    m = await meetingRow(id);
    assert.equal(m.status, 'extracting', 'transcript saved, extraction queued');
    assert.equal(m.bot_reason, 'left_alone');
    assert.ok(m.ended_at);
    const [segs] = await pool.query('SELECT s.vexa_segment_id, s.speaker, s.text, s.start_sec, s.language FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id WHERE t.meeting_id = ? ORDER BY s.id', [id]);
    assert.deepEqual(segs.map((s) => [s.vexa_segment_id, s.speaker, s.start_sec, s.language]), [
      ['v1', 'Jane Liu', '12.40', 'en'],
      ['v2', null, '16.00', 'de'],
    ]);
    const [[t]] = await pool.query('SELECT raw_json FROM transcripts WHERE meeting_id = ?', [id]);
    assert.equal(t.raw_json.source, 'vexa');
    assert.equal(t.raw_json.vexaMeetingId, 501);
    assert.equal((await extractJobs(id)).length, 1);
    assert.equal((await pollJob(id)).status, 'succeeded');
    assert.deepEqual((await auditActions(id)).filter((a) => a !== 'meeting.created'), [
      'bot.requested', 'bot.status_changed', 'bot.status_changed', 'bot.status_changed',
      'transcript.imported_from_vexa', 'extraction.requested',
    ]);

    // Nothing further happens; no more polls, no auto-approval, no email.
    assert.equal(await tick(), false);
    const [[{ approved }]] = await pool.query("SELECT COUNT(*) AS approved FROM action_items WHERE meeting_id = ? AND review_status = 'approved'", [id]);
    assert.equal(approved, 0);
    const [[{ emails }]] = await pool.query('SELECT COUNT(*) AS emails FROM email_messages WHERE meeting_id = ?', [id]);
    assert.equal(emails, 0);
  });

  it('stops on a failed bot and explains why', async () => {
    const id = await requestedMeeting();
    remote.status = 'failed';
    remote.reason = 'awaiting_admission_rejected';
    await tick();
    const m = await meetingRow(id);
    assert.equal(m.status, 'failed');
    assert.match(m.last_error, /host declined to admit the bot/);
    assert.equal((await pollJob(id)).status, 'succeeded');
    assert.equal(await tick(), false);
    // The admin can request a new bot afterwards.
    remote.status = 'requested';
    assert.equal((await A().post(`/api/v1/meetings/${id}/bot`)).status, 202);
  });

  it('retries temporary errors with backoff, and waits out rate limits without using attempts', async () => {
    const id = await requestedMeeting();
    scripted['GET /meetings/501'] = [{ status: 503, body: { detail: 'busy' } }, new TypeError('socket hang up')];
    await tick();
    let job = await pollJob(id);
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.match(job.last_error, /503/);
    await tick();
    assert.equal((await pollJob(id)).attempts, 2);

    scripted['GET /meetings/501'] = [{ status: 429, body: { detail: 'slow' }, headers: { 'retry-after': '7' } }];
    await tick();
    job = await pollJob(id);
    assert.equal(job.attempts, 2, '429 reschedules without counting');

    remote.status = 'active';
    await tick();
    assert.equal((await meetingRow(id)).status, 'in_progress');
  });

  it('fails permanently on authentication errors', async () => {
    const id = await requestedMeeting();
    scripted['GET /meetings/501'] = [{ status: 401, body: { detail: 'Invalid API key' } }];
    await tick();
    const m = await meetingRow(id);
    assert.equal(m.status, 'failed');
    assert.match(m.last_error, /Lost track of the bot: Vexa rejected the API key/);
    assert.equal((await pollJob(id)).status, 'failed');
    assert.ok((await auditActions(id)).includes('bot.tracking_failed'));
  });

  it('treats invalid Vexa responses as retryable and gives up after the attempt limit', async () => {
    const id = await requestedMeeting();
    scripted['GET /meetings/501'] = Array.from({ length: 10 }, () => ({ status: 200, body: { id: 501, status: 'banana' } }));
    for (let i = 0; i < 8; i++) await tick();
    const job = await pollJob(id);
    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, job.max_attempts);
    assert.equal((await meetingRow(id)).status, 'failed');
  });

  it('gives up after the polling timeout', async () => {
    const id = await requestedMeeting();
    await pool.query("UPDATE jobs SET payload = JSON_SET(payload, '$.startedAt', 0) WHERE type = 'vexa.poll'");
    await tick();
    const m = await meetingRow(id);
    assert.equal(m.status, 'failed');
    assert.match(m.last_error, /Stopped following the bot/);
  });

  it('survives a worker restart', async () => {
    const id = await requestedMeeting();
    await makeDue();
    const claimed = await queue.claimNext('crashed-worker', ['vexa.poll']);
    await pool.query('UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?', [claimed.id]);
    assert.deepEqual(await recover(handlers), { requeued: 1, dead: 0 });
    remote.status = 'active';
    await tick();
    assert.equal((await meetingRow(id)).status, 'in_progress');
  });

  it('adopts the Vexa meeting id from the transcript endpoint when POST /bots gave none', async () => {
    scripted['POST /bots'] = [{ status: 201, body: {} }];
    const id = await requestedMeeting();
    remote.status = 'active';
    await tick();
    const m = await meetingRow(id);
    assert.equal(m.vexa_meeting_id, '501');
    assert.equal(m.status, 'in_progress');
  });

  it('does not adopt an older finished session on the same link', async () => {
    scripted['POST /bots'] = [{ status: 201, body: {} }];
    const id = await requestedMeeting();
    remote.status = 'completed';
    remote.startTime = '2020-01-01T00:00:00Z';
    remote.segments = SEGMENTS;
    await tick();
    const m = await meetingRow(id);
    assert.equal(m.vexa_meeting_id, null);
    assert.equal(m.status, 'bot_requested');
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?', [id]))[0][0].n, 0);
  });
});

describe('transcript ingestion', () => {
  async function completedMeeting({ segments = SEGMENTS } = {}) {
    const id = await requestedMeeting();
    remote.status = 'completed';
    remote.segments = segments;
    return id;
  }

  it('waits for segments after the meeting ends, then leaves a clear message', async () => {
    const id = await completedMeeting({ segments: [{ segment_id: 'x', speaker: 'A', text: 'draft', start: 1, end: 2, language: 'en', completed: false }] });
    await tick();
    let m = await meetingRow(id);
    assert.equal(m.status, 'ended');
    assert.equal((await pollJob(id)).status, 'pending', 'keeps checking for the transcript');

    config.vexa.transcriptWaitMs = 0;
    await tick();
    m = await meetingRow(id);
    assert.equal(m.status, 'ended');
    assert.match(m.last_error, /produced no transcript/);
    assert.equal((await pollJob(id)).status, 'succeeded');
    // Manual upload is still available.
    assert.equal((await A().post(`/api/v1/meetings/${id}/transcript/upload`, { content: '[00:01] Jane: manual' })).status, 201);
  });

  it('never imports twice or queues duplicate extraction jobs', async () => {
    const id = await completedMeeting();
    await tick();
    assert.equal(await importTranscript(id), 'already_imported');
    const res = await A().post(`/api/v1/meetings/${id}/transcript/refresh`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'already_imported');
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?', [id]))[0][0].n, 1);
    assert.equal((await extractJobs(id)).length, 1);
  });

  it('does not overwrite a manual transcript unless asked explicitly', async () => {
    const id = await completedMeeting({ segments: [] });
    config.vexa.transcriptWaitMs = 0;
    await tick(); // bot completed, no segments -> 'ended'
    assert.equal((await A().post(`/api/v1/meetings/${id}/transcript/upload`, { content: '[00:01] Jane: manual notes' })).status, 201);

    remote.segments = SEGMENTS;
    assert.equal(await importTranscript(id), 'conflict');
    let res = await A().post(`/api/v1/meetings/${id}/transcript/refresh`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TRANSCRIPT_EXISTS');
    const [[kept]] = await pool.query('SELECT raw_json FROM transcripts WHERE meeting_id = ?', [id]);
    assert.equal(kept.raw_json.source, 'manual_upload');
    assert.ok((await auditActions(id)).includes('transcript.vexa_import_skipped'));

    res = await A().post(`/api/v1/meetings/${id}/transcript/refresh`, { replace: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'saved');
    assert.equal(res.body.extraction, 'queued');
    const [[replaced]] = await pool.query('SELECT raw_json FROM transcripts WHERE meeting_id = ?', [id]);
    assert.equal(replaced.raw_json.source, 'vexa');
    assert.equal((await A().post(`/api/v1/meetings/${id}/transcript/refresh`, { replace: 'yes' })).status, 400);
  });

  it('leaves the meeting ready for manual extraction when auto-extract is off or AI is not configured', async () => {
    config.vexa.autoExtract = false;
    let id = await completedMeeting();
    await tick();
    assert.equal((await meetingRow(id)).status, 'transcript_ready');
    assert.equal((await extractJobs(id)).length, 0);

    await pool.query('DELETE FROM meetings');
    await pool.query('DELETE FROM jobs');
    config.vexa.autoExtract = true;
    claude.isConfigured = () => false;
    id = await completedMeeting();
    await tick();
    assert.equal((await meetingRow(id)).status, 'transcript_ready');
    assert.equal((await extractJobs(id)).length, 0);
  });
});

describe('stopping and checking', () => {
  it('stops a live bot and keeps following it to the transcript', async () => {
    const id = await requestedMeeting();
    remote.status = 'active';
    await tick();
    const res = await A().del(`/api/v1/meetings/${id}/bot`);
    assert.equal(res.status, 202);
    assert.equal(res.body.bot.bot.status, 'stopping');
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/bots/google_meet/abc-defg-hij'));
    assert.ok((await auditActions(id)).includes('bot.stop_requested'));

    remote.status = 'completed';
    remote.segments = SEGMENTS;
    await tick();
    assert.equal((await meetingRow(id)).status, 'extracting');
    assert.equal((await A().del(`/api/v1/meetings/${id}/bot`)).status, 409, 'nothing left to stop');
  });

  it('checks status on demand and resumes polling after a tracking failure', async () => {
    const id = await requestedMeeting();
    scripted['GET /meetings/501'] = [{ status: 401, body: { detail: 'Invalid API key' } }];
    await tick();
    assert.equal((await meetingRow(id)).status, 'failed');

    remote.status = 'active';
    const res = await A().post(`/api/v1/meetings/${id}/bot/check`);
    assert.equal(res.status, 200);
    assert.equal(res.body.bot.meetingStatus, 'in_progress');
    assert.equal(res.body.bot.polling.status, 'pending');
  });

  it('keeps manual uploads working for meetings without a bot', async () => {
    const id = await newMeeting('https://teams.example/some-meeting');
    const res = await A().post(`/api/v1/meetings/${id}/transcript/upload`, { content: '[00:01] Jane: manual' });
    assert.equal(res.status, 201);
    assert.equal((await A().post(`/api/v1/meetings/${id}/transcript/refresh`, {})).status, 409);
  });
});
