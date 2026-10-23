// Job 'vexa.poll' { meetingId, startedAt }: follows a Vexa bot until it finishes, then imports
// the transcript and queues extraction (PLANNING.md §5 phase 7: "URL in -> review queue out").
//
// - One active poller per meeting (dedupe_key), claimed with SKIP LOCKED like every job.
// - While the bot is live (incl. waiting in the lobby) the job reschedules itself every
//   VEXA_POLL_INTERVAL_MS; this doesn't use up attempts. Temporary Vexa errors use the normal
//   bounded retry/backoff; 429 waits for Retry-After.
// - Stops on a terminal state, when the meeting moved on, or after VEXA_POLL_TIMEOUT_MS.
// - After a worker restart the job is still in MySQL (pending, or recovered from a stale lease).
import { config } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import * as meetings from '../../repositories/meetingsRepository.js';
import { audit } from '../../services/audit.js';
import { TRACKED_STATUSES, autoExtract, checkStatus, importTranscript } from '../../services/meetingBot.js';
import { VexaError } from '../../services/vexa/client.js';
import { logger } from '../../utils/logger.js';
import { PermanentJobError, RescheduleJob } from '../queue.js';

async function markFailed(meetingId, message) {
  await withTransaction(async (conn) => {
    const m = await meetings.findByIdForUpdate(conn, meetingId);
    if (m && TRACKED_STATUSES.includes(m.status)) await meetings.update(conn, meetingId, { status: 'failed', lastError: message });
  });
}

async function run(job) {
  const { meetingId, startedAt } = job.payload;
  const meeting = await meetings.findById(meetingId);
  if (!meeting || !TRACKED_STATUSES.includes(meeting.status)) return; // nothing left to follow
  if (!meeting.native_meeting_id) throw new PermanentJobError('Meeting has no Vexa link');

  if (Date.now() - (startedAt ?? Date.now()) > config.vexa.pollTimeoutMs) {
    const hours = Math.round(config.vexa.pollTimeoutMs / 3_600_000);
    await markFailed(meetingId, `Stopped following the bot after ${hours} hour(s). Use "Check status" or import the transcript manually.`);
    await audit({ action: 'bot.tracking_timed_out', entityType: 'meeting', entityId: meetingId });
    return;
  }

  let state;
  try {
    state = await checkStatus(meeting);
  } catch (err) {
    if (err instanceof VexaError && err.kind === 'rate_limited') throw new RescheduleJob(err.retryAfterMs ?? config.vexa.pollIntervalMs, 'rate limited');
    if (err instanceof VexaError && !err.retryable) throw new PermanentJobError(err.message, { publicMessage: err.publicMessage });
    throw err; // retryable: queue backoff
  }

  if (state.live) throw new RescheduleJob(config.vexa.pollIntervalMs, `bot ${state.vexaStatus}`);
  if (state.failed) return; // checkStatus recorded the failure and reason

  // Completed: import the transcript (idempotent) and hand it to extraction.
  let outcome;
  try {
    outcome = await importTranscript(meetingId);
  } catch (err) {
    if (err instanceof VexaError && err.kind === 'rate_limited') throw new RescheduleJob(err.retryAfterMs ?? config.vexa.pollIntervalMs, 'rate limited');
    if (err instanceof VexaError && !err.retryable) throw new PermanentJobError(err.message, { publicMessage: err.publicMessage });
    throw err;
  }

  if (outcome === 'empty') {
    // Segments can arrive shortly after the bot leaves; wait a bounded time before giving up.
    const fresh = await meetings.findById(meetingId);
    const endedAt = fresh.ended_at ? new Date(fresh.ended_at).getTime() : Date.now();
    // MySQL DATETIME rounds to the nearest second, so ended_at can be up to 0.5 s "in the future".
    const waitedMs = Math.max(0, Date.now() - endedAt);
    if (waitedMs < config.vexa.transcriptWaitMs) throw new RescheduleJob(config.vexa.pollIntervalMs, 'transcript not ready');
    await withTransaction(async (conn) => {
      const m = await meetings.findByIdForUpdate(conn, meetingId);
      if (m?.status === 'ended') await meetings.update(conn, meetingId, { lastError: 'The meeting ended but Vexa produced no transcript. Upload one manually or try "Import Vexa transcript" later.' });
    });
    return;
  }
  if (outcome === 'saved' || outcome === 'already_imported') {
    const extraction = await autoExtract(meetingId);
    logger.info('vexa transcript imported', { meetingId, outcome, extraction });
  } else {
    logger.info('vexa transcript not imported', { meetingId, outcome });
  }
}

/** When polling gives up for good, leave the meeting in a state the admin can act on. */
async function onFailure(job, err, { final }) {
  if (!final) return;
  const message = `Lost track of the bot: ${err.publicMessage ?? err.message}`.slice(0, 500);
  await markFailed(job.payload.meetingId, message);
  await audit({ action: 'bot.tracking_failed', entityType: 'meeting', entityId: job.payload.meetingId, after: { error: err.message } });
}

export const vexaPoll = { run, onFailure };
