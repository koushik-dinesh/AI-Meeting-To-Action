// Admin meeting-bot endpoints (Phase 7). The browser never talks to Vexa; these do.
import { config } from '../config/index.js';
import * as queue from '../jobs/queue.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import * as bot from '../services/meetingBot.js';
import { audit } from '../services/audit.js';
import { VexaError, vexa } from '../services/vexa/client.js';
import { describeReason, parseGoogleMeetUrl } from '../services/vexa/mapper.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { extractionStatus } from './extractionController.js';

/** Everything the bot panel needs, from our database (no Vexa call). */
async function botView(meetingId) {
  const m = await meetings.findById(meetingId);
  if (!m) throw notFound('Meeting not found');
  const [check, transcript, pollJob, extraction] = await Promise.all([
    bot.eligibility(m),
    transcripts.findSummaryByMeeting(meetingId),
    queue.findActiveByDedupeKey(bot.pollJobKey(meetingId)),
    extractionStatus(meetingId),
  ]);
  return {
    configured: vexa.isConfigured(),
    meetingStatus: m.status,
    lastError: m.last_error,
    linkValid: Boolean(parseGoogleMeetUrl(m.meeting_url)),
    canRequest: check.ok,
    cannotRequestReason: check.ok ? null : check.message,
    bot: m.native_meeting_id
      ? {
          platform: m.platform,
          nativeMeetingId: m.native_meeting_id,
          vexaMeetingId: m.vexa_meeting_id,
          status: m.bot_status,
          reason: m.bot_reason,
          reasonText: describeReason(m.bot_reason),
          requestedAt: m.bot_requested_at,
          checkedAt: m.bot_checked_at,
          startedAt: m.started_at,
          endedAt: m.ended_at,
        }
      : null,
    polling: pollJob ? { status: pollJob.status, nextCheckAt: pollJob.status === 'pending' ? pollJob.runAt : null, attempts: pollJob.attempts, lastError: pollJob.lastError } : null,
    transcript: transcript ? { source: transcript.source, segmentCount: transcript.segment_count } : null,
    extraction: extraction && { status: extraction.status, error: extraction.status === 'failed' ? m.last_error : null },
    autoExtract: config.vexa.autoExtract,
  };
}

export async function get(req, res) {
  res.json({ bot: await botView(req.params.id) });
}

export async function request(req, res) {
  await bot.requestBot(req.params.id, req.user.id, req.ip);
  res.status(202).json({ bot: await botView(req.params.id) });
}

export async function stop(req, res) {
  await bot.stopBot(req.params.id, req.user.id, req.ip);
  res.status(202).json({ bot: await botView(req.params.id) });
}

/** Checks Vexa now (instead of waiting for the next poll) and resumes polling if needed. */
export async function check(req, res) {
  const { id } = req.params;
  if (!vexa.isConfigured()) throw new AppError(503, 'VEXA_NOT_CONFIGURED', 'The meeting bot is not configured on the server (VEXA_BASE_URL / VEXA_API_KEY)');
  const m = await meetings.findById(id);
  if (!m) throw notFound('Meeting not found');
  if (!m.native_meeting_id) throw conflict('No bot has been requested for this meeting');
  let state;
  try {
    state = await bot.checkStatus(m);
  } catch (err) {
    if (err instanceof VexaError) throw new AppError(err.kind === 'auth' ? 502 : 503, `VEXA_${err.kind.toUpperCase()}`, err.publicMessage);
    throw err;
  }
  const after = await meetings.findById(id);
  if (bot.TRACKED_STATUSES.includes(after.status) && (state.live || state.completed)) await bot.ensurePolling(Number(id));
  res.json({ bot: await botView(id) });
}

/**
 * POST /meetings/:id/transcript/refresh (PLANNING.md: "re-fetch from Vexa").
 * Imports the Vexa transcript now. An existing transcript is replaced only with {"replace": true}.
 */
export async function importTranscript(req, res) {
  const { id } = req.params;
  if (!vexa.isConfigured()) throw new AppError(503, 'VEXA_NOT_CONFIGURED', 'The meeting bot is not configured on the server (VEXA_BASE_URL / VEXA_API_KEY)');
  let outcome;
  try {
    outcome = await bot.importTranscript(id, { replace: req.body.replace, actorId: req.user.id });
  } catch (err) {
    if (err instanceof VexaError) throw new AppError(err.kind === 'not_found' ? 404 : err.kind === 'auth' ? 502 : 503, `VEXA_${err.kind.toUpperCase()}`, err.publicMessage);
    throw err;
  }
  if (outcome === 'conflict') throw new AppError(409, 'TRANSCRIPT_EXISTS', 'This meeting already has a transcript. Choose “Replace with Vexa transcript” to overwrite it.');
  if (outcome === 'empty') throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'Vexa has no transcript segments for this meeting yet');
  if (outcome === 'locked') throw new AppError(409, 'TRANSCRIPT_LOCKED', 'The transcript can’t be replaced at this stage of the review');

  const extraction = outcome === 'saved' ? await bot.autoExtract(Number(id)) : null;
  if (outcome === 'saved') {
    await audit({ actorUserId: req.user.id, action: 'transcript.import_requested', entityType: 'meeting', entityId: id, after: { replace: req.body.replace, extraction }, ip: req.ip });
  }
  res.json({ outcome, extraction, bot: await botView(id) });
}
