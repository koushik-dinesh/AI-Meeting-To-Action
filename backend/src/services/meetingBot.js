// Meeting-bot workflow (Phase 7): request a Vexa bot, track it, import its transcript, hand the
// transcript to the existing extraction pipeline. Vexa itself stays a separate service; all HTTP
// goes through services/vexa/client.js, and no DB transaction is open during an HTTP call.
//
// Transcript policy: a Vexa transcript is imported automatically only when the meeting has no
// transcript. If one already exists (e.g. uploaded manually), it is never overwritten silently:
// the import is skipped and the admin can replace it explicitly ("Import Vexa transcript").
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import * as queue from '../jobs/queue.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { claude } from './ai/claudeClient.js';
import { audit } from './audit.js';
import { requestExtraction } from './extraction.js';
import { TranscriptParseError, parseTranscript, renderFullText } from './transcripts/parser.js';
import { VexaError, vexa } from './vexa/client.js';
import { BOT_ACTIVE_MEETING_STATUSES, TERMINAL_VEXA_STATUSES, describeReason, parseGoogleMeetUrl, toMeetingStatus } from './vexa/mapper.js';

// Statuses from which a bot may be requested (and only when there is no transcript yet).
const BOT_REQUESTABLE = ['draft', 'failed'];
// Same rule as manual uploads (transcriptsController REPLACEABLE_STATUSES).
const TRANSCRIPT_REPLACEABLE = ['draft', 'ended', 'transcript_ready', 'failed'];
// Statuses in which the poller still has something to do.
export const TRACKED_STATUSES = [...BOT_ACTIVE_MEETING_STATUSES, 'ended'];

export const pollJobKey = (meetingId) => `vexa.poll:meeting:${meetingId}`;
const POLL_MAX_ATTEMPTS = 6;

/** Maps a VexaError from an admin request to an HTTP error. */
function httpError(err) {
  if (!(err instanceof VexaError)) return err;
  const status = { not_configured: 503, validation: 400, conflict: 409, not_found: 404, rate_limited: 503, busy: 503, unavailable: 503 }[err.kind] ?? 502;
  return new AppError(status, `VEXA_${err.kind.toUpperCase()}`, err.publicMessage);
}

function assertConfigured() {
  if (!vexa.isConfigured()) {
    throw new AppError(503, 'VEXA_NOT_CONFIGURED', 'The meeting bot is not configured on the server (VEXA_BASE_URL / VEXA_API_KEY)');
  }
}

/** Ensures a poll job exists (dedupe key = one active poller per meeting). */
export async function ensurePolling(meetingId, { conn, delayMs = 0 } = {}) {
  try {
    const jobId = await queue.enqueue('vexa.poll', { meetingId, startedAt: Date.now() }, { dedupeKey: pollJobKey(meetingId), maxAttempts: POLL_MAX_ATTEMPTS, conn, delayMs });
    return { jobId, created: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { created: false };
    throw err;
  }
}

/** Whether the meeting can get a bot right now, and if not why. */
export async function eligibility(meeting) {
  if (!vexa.isConfigured()) return { ok: false, code: 'VEXA_NOT_CONFIGURED', message: 'The meeting bot is not configured on the server' };
  if (!parseGoogleMeetUrl(meeting.meeting_url)) {
    return { ok: false, code: 'INVALID_MEETING_URL', message: 'The meeting link must be a Google Meet link like https://meet.google.com/abc-defg-hij' };
  }
  if (BOT_ACTIVE_MEETING_STATUSES.includes(meeting.status)) return { ok: false, code: 'BOT_ALREADY_ACTIVE', message: 'A bot is already requested or in the meeting' };
  if (!BOT_REQUESTABLE.includes(meeting.status)) return { ok: false, code: 'NOT_ELIGIBLE', message: `A bot can’t be requested while the meeting is "${meeting.status.replaceAll('_', ' ')}"` };
  if (await transcripts.findSummaryByMeeting(meeting.id)) return { ok: false, code: 'TRANSCRIPT_EXISTS', message: 'This meeting already has a transcript' };
  return { ok: true };
}

/** POST /meetings/:id/bot */
export async function requestBot(meetingId, actorId, ip) {
  assertConfigured();

  // 1) Claim the meeting in a short transaction. This is the idempotency gate: a second or
  //    concurrent request sees 'bot_requested' and is refused.
  const claimed = await withTransaction(async (conn) => {
    const meeting = await meetings.findByIdForUpdate(conn, meetingId);
    if (!meeting) throw notFound('Meeting not found');
    const check = await eligibility(meeting);
    if (!check.ok) throw new AppError(check.code === 'INVALID_MEETING_URL' ? 400 : 409, check.code, check.message);
    const link = parseGoogleMeetUrl(meeting.meeting_url);
    const other = await meetings.findActiveBotOnLink(conn, link.platform, link.nativeMeetingId, meetingId);
    if (other) throw new AppError(409, 'LINK_IN_USE', `Another meeting (“${other.title}”) already has a bot on this link`);
    try {
      await meetings.update(conn, meetingId, {
        status: 'bot_requested',
        platform: link.platform,
        nativeMeetingId: link.nativeMeetingId,
        vexaMeetingId: null,
        botStatus: 'requested',
        botReason: null,
        botRequestedAt: new Date(),
        botCheckedAt: null,
        startedAt: null,
        endedAt: null,
        lastError: null,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, 'LINK_IN_USE', 'Another meeting at the same time already uses this link');
      throw err;
    }
    return { previousStatus: meeting.status, link, language: meeting.language_hint };
  });

  // 2) Ask Vexa (no transaction open).
  let result;
  try {
    result = await vexa.requestBot({
      platform: claimed.link.platform,
      nativeMeetingId: claimed.link.nativeMeetingId,
      botName: config.vexa.botName,
      language: claimed.language,
    });
  } catch (err) {
    if (err instanceof VexaError && err.kind === 'conflict') {
      // PLANNING.md: 409 = a bot is already running on this link; track it instead of failing.
      result = { id: null, status: null, adopted: true };
    } else {
      // Undo the claim so the admin can try again; keep the reason visible.
      await withTransaction(async (conn) => {
        const m = await meetings.findByIdForUpdate(conn, meetingId);
        if (m?.status === 'bot_requested') {
          await meetings.update(conn, meetingId, { status: claimed.previousStatus, botStatus: 'failed', lastError: err.publicMessage ?? err.message });
        }
      });
      await audit({ actorUserId: actorId, action: 'bot.request_failed', entityType: 'meeting', entityId: meetingId, after: { error: err.message }, ip });
      throw httpError(err);
    }
  }

  // 3) Record what Vexa told us (only validated values) and start polling.
  await withTransaction(async (conn) => {
    await meetings.update(conn, meetingId, {
      vexaMeetingId: result.id !== null ? String(result.id) : undefined,
      botStatus: result.status ?? undefined,
      status: result.status ? toMeetingStatus(result.status) : undefined,
      botCheckedAt: new Date(),
    });
    await ensurePolling(meetingId, { conn, delayMs: config.vexa.pollIntervalMs });
  });
  await audit({
    actorUserId: actorId,
    action: 'bot.requested',
    entityType: 'meeting',
    entityId: meetingId,
    before: { status: claimed.previousStatus },
    after: { platform: claimed.link.platform, nativeMeetingId: claimed.link.nativeMeetingId, vexaMeetingId: result.id, adoptedExistingBot: Boolean(result.adopted) },
    ip,
  });
}

/** DELETE /meetings/:id/bot */
export async function stopBot(meetingId, actorId, ip) {
  assertConfigured();
  const meeting = await meetings.findById(meetingId);
  if (!meeting) throw notFound('Meeting not found');
  if (!BOT_ACTIVE_MEETING_STATUSES.includes(meeting.status) || !meeting.native_meeting_id) {
    throw conflict('There is no active bot to stop for this meeting');
  }
  try {
    await vexa.stopBot(meeting.platform, meeting.native_meeting_id);
  } catch (err) {
    throw httpError(err);
  }
  await withTransaction(async (conn) => {
    const m = await meetings.findByIdForUpdate(conn, meetingId);
    if (BOT_ACTIVE_MEETING_STATUSES.includes(m?.status)) await meetings.update(conn, meetingId, { botStatus: 'stopping', botCheckedAt: new Date() });
    // The poller follows it to 'completed' and then imports the transcript.
    await ensurePolling(meetingId, { conn });
  });
  await audit({ actorUserId: actorId, action: 'bot.stop_requested', entityType: 'meeting', entityId: meetingId, ip });
}

/**
 * Asks Vexa for the bot's current state (one or two HTTP calls, no transaction) and records it.
 * Returns { vexaStatus, completed, failed, live }.
 */
export async function checkStatus(meeting) {
  let state;
  if (meeting.vexa_meeting_id) {
    state = await vexa.getMeeting(meeting.vexa_meeting_id);
  } else {
    // POST /bots gave no usable id (its body is untyped): the transcript endpoint returns the
    // newest meeting on the link with its id and status. Adopt the id only for a meeting that
    // started after our request, so an older session on the same link is never mistaken for ours.
    const t = await vexa.getTranscript(meeting.platform, meeting.native_meeting_id);
    const requestedAt = meeting.bot_requested_at ? new Date(meeting.bot_requested_at).getTime() - 60_000 : 0;
    const startedAt = t.startTime ? Date.parse(t.startTime) : null;
    const isOurs = t.id !== null && t.status && (startedAt === null ? !TERMINAL_VEXA_STATUSES.includes(t.status) : startedAt >= requestedAt);
    state = isOurs ? t : { id: null, status: meeting.bot_status ?? 'requested', completionReason: null };
  }
  if (!state.status) throw new VexaError('invalid_response', 'Vexa returned no status', { retryable: true, publicMessage: 'Vexa returned an unexpected response' });

  const nextStatus = toMeetingStatus(state.status);
  const reason = state.completionReason ?? (state.status === 'failed' && state.failureStage ? `failed_while_${state.failureStage}` : null);
  await withTransaction(async (conn) => {
    const m = await meetings.findByIdForUpdate(conn, meeting.id);
    if (!m || !TRACKED_STATUSES.concat('failed').includes(m.status)) return; // moved on (e.g. transcript imported)
    const fields = {
      vexaMeetingId: state.id !== null && !m.vexa_meeting_id ? String(state.id) : undefined,
      botStatus: state.status,
      botReason: reason,
      botCheckedAt: new Date(),
    };
    if (state.status === 'active' && !m.started_at) fields.startedAt = new Date();
    if (state.status === 'completed' && !m.ended_at) fields.endedAt = new Date();
    // Only advance the meeting lifecycle; never move a meeting that already has a transcript back.
    if (nextStatus && m.status !== nextStatus && (BOT_ACTIVE_MEETING_STATUSES.includes(m.status) || m.status === 'failed')) {
      fields.status = nextStatus;
      fields.lastError = nextStatus === 'failed' ? `The bot failed: ${describeReason(reason) ?? 'no reason given'}` : null;
    }
    await meetings.update(conn, meeting.id, fields);
    if (fields.status && fields.status !== m.status) {
      await audit({ action: 'bot.status_changed', entityType: 'meeting', entityId: meeting.id, before: { status: m.status, botStatus: m.bot_status }, after: { status: fields.status, botStatus: state.status, reason } });
    }
  });
  return {
    vexaStatus: state.status,
    completed: state.status === 'completed',
    failed: state.status === 'failed',
    live: !TERMINAL_VEXA_STATUSES.includes(state.status),
  };
}

/**
 * Fetches the Vexa transcript and saves it via the existing parser/repository.
 * @returns 'saved' | 'already_imported' | 'conflict' | 'empty' | 'locked'
 */
export async function importTranscript(meetingId, { replace = false, actorId = null } = {}) {
  const meeting = await meetings.findById(meetingId);
  if (!meeting) throw notFound('Meeting not found');
  if (!meeting.native_meeting_id) throw conflict('This meeting has no Vexa bot');

  const t = await vexa.getTranscript(meeting.platform, meeting.native_meeting_id); // HTTP, no transaction
  if (meeting.vexa_meeting_id && t.id !== null && String(t.id) !== String(meeting.vexa_meeting_id)) {
    // A newer session on the same link exists; don't import someone else's meeting.
    throw new AppError(409, 'VEXA_MEETING_MISMATCH', 'Vexa returned a different meeting on this link; its transcript was not imported');
  }

  let parsed;
  try {
    // Reuse the manual-upload parser: keeps speaker, timestamps, language, confidence and drops
    // incomplete (completed:false) drafts.
    parsed = parseTranscript(JSON.stringify({ segments: t.segments }), { format: 'vexa_json' });
  } catch (err) {
    if (err instanceof TranscriptParseError) return 'empty';
    throw err;
  }

  const outcome = await withTransaction(async (conn) => {
    const m = await meetings.findByIdForUpdate(conn, meetingId);
    const existing = await transcripts.findSummaryByMeeting(meetingId);
    if (existing) {
      const [[raw]] = await conn.query("SELECT JSON_VALUE(raw_json, '$.vexaMeetingId') AS vexa_id FROM transcripts WHERE meeting_id = ?", [meetingId]);
      if (existing.source === 'vexa' && raw?.vexa_id && String(raw.vexa_id) === String(t.id ?? meeting.vexa_meeting_id)) return 'already_imported';
      if (!replace) return 'conflict';
    }
    if (!TRANSCRIPT_REPLACEABLE.includes(m.status)) return 'locked';

    await transcripts.replaceForMeeting(conn, meetingId, {
      fullText: renderFullText(parsed.segments),
      rawJson: { source: 'vexa', format: 'vexa_json', filename: null, vexaMeetingId: t.id ?? meeting.vexa_meeting_id, platform: meeting.platform, nativeMeetingId: meeting.native_meeting_id, data: { segments: t.segments } },
      detectedLanguages: [...new Set(parsed.segments.map((s) => s.language).filter(Boolean))],
      segments: parsed.segments,
    });
    await meetings.update(conn, meetingId, { status: 'transcript_ready', lastError: null });
    return 'saved';
  });

  if (outcome === 'saved' || outcome === 'conflict') {
    await audit({
      actorUserId: actorId,
      action: outcome === 'saved' ? 'transcript.imported_from_vexa' : 'transcript.vexa_import_skipped',
      entityType: 'meeting',
      entityId: meetingId,
      after: { vexaMeetingId: t.id, segments: parsed.segments.length, replaced: replace, reason: outcome === 'conflict' ? 'A transcript already exists' : undefined },
    });
  }
  return outcome;
}

/**
 * After a Vexa transcript is saved: queue extraction through the shared service (same checks,
 * same dedupe key, so repeated polls can't create duplicate jobs). Never approves or emails.
 * Returns 'queued' | 'disabled' | 'not_configured' | 'skipped'.
 */
export async function autoExtract(meetingId) {
  if (!config.vexa.autoExtract) return 'disabled';
  if (!claude.isConfigured()) return 'not_configured';
  try {
    const r = await requestExtraction(meetingId, { requestedBy: null });
    await audit({ action: 'extraction.requested', entityType: 'meeting', entityId: meetingId, before: { status: r.previousStatus }, after: { status: 'extracting', runId: r.runId, jobId: r.jobId, trigger: 'vexa_transcript' } });
    return 'queued';
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn('auto extraction not queued', { meetingId, code: err.code });
      return 'skipped';
    }
    throw err;
  }
}
