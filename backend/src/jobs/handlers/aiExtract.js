// Job 'ai.extract' { meetingId, runId }: transcript -> Claude -> validation -> action_items.
//
// Idempotent: a run that already succeeded is skipped, and saving replaces the meeting's
// pending AI items in one transaction, so a retry or re-run never duplicates tasks.
// No locks are held while Claude is working; the meeting row is locked only to save.
import { config } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import * as actionItems from '../../repositories/actionItemsRepository.js';
import * as aliasesRepo from '../../repositories/aliasesRepository.js';
import * as runs from '../../repositories/extractionRunsRepository.js';
import * as meetings from '../../repositories/meetingsRepository.js';
import * as transcripts from '../../repositories/transcriptsRepository.js';
import * as usersRepo from '../../repositories/usersRepository.js';
import { claude } from '../../services/ai/claudeClient.js';
import { buildSystemPrompt, buildUserMessage, renderTranscript } from '../../services/ai/extractionPrompt.js';
import { validateExtraction } from '../../services/ai/validator.js';
import { audit } from '../../services/audit.js';
import { buildDirectory } from '../../services/matching/assigneeMatcher.js';
import { localDate, weekdayName } from '../../utils/dates.js';
import { logger } from '../../utils/logger.js';
import { PermanentJobError } from '../queue.js';

async function loadContext(meetingId, meeting) {
  const summary = await transcripts.findSummaryByMeeting(meetingId);
  if (!summary) throw new PermanentJobError(`Meeting ${meetingId} has no transcript`, { publicMessage: 'The meeting has no transcript' });

  const [segmentRows, userRows, aliasRows, participantIds, existing] = await Promise.all([
    transcripts.findSegments(summary.id),
    usersRepo.list({ includeInactive: true }),
    aliasesRepo.listAll(),
    meetings.listParticipantIds(meetingId),
    actionItems.listReviewed(meetingId),
  ]);

  const segments = segmentRows.map(transcripts.toSegment);
  const users = userRows.map((u) => ({ id: u.id, fullName: u.full_name, isActive: Boolean(u.is_active) }));
  const aliases = aliasRows.map(aliasesRepo.toAlias);
  const { text: transcriptText, refs } = renderTranscript(segments);
  if (transcriptText.length > config.extraction.maxTranscriptChars) {
    throw new PermanentJobError(`Transcript has ${transcriptText.length} characters`, { publicMessage: 'The transcript is too long to extract from' });
  }

  // Relative deadlines are resolved from the meeting's own date, never the processing date.
  const when = meeting.scheduled_at ?? meeting.started_at;
  const timezone = config.extraction.timezone;
  const refDate = when ? localDate(new Date(when), timezone) : null;

  const participants = users
    .filter((u) => participantIds.includes(u.id))
    .map((u) => ({ fullName: u.fullName, aliases: aliases.filter((a) => a.userId === u.id).map((a) => a.alias) }));

  return {
    prompt: {
      system: buildSystemPrompt(config.extraction.outputLanguage),
      user: buildUserMessage({
        meeting: { title: meeting.title, localDate: refDate, weekday: refDate ? weekdayName(refDate) : null, timezone },
        participants,
        transcriptText,
      }),
    },
    validation: { refs, segments, directory: buildDirectory(users, aliases), refDate, existing },
  };
}

/** Throws unless the meeting is still waiting for exactly this run. */
function assertCurrent(meeting, latestRun, runId) {
  if (!meeting) throw new PermanentJobError('Meeting no longer exists');
  if (meeting.status !== 'extracting') {
    throw new PermanentJobError(`Meeting status is "${meeting.status}", not "extracting"`, { publicMessage: 'The meeting is no longer waiting for extraction' });
  }
  if (latestRun?.id !== runId) throw new PermanentJobError(`Run ${runId} was superseded by run ${latestRun?.id}`);
}

async function run(job) {
  const { meetingId, runId } = job.payload;
  const existingRun = await runs.findById(runId);
  if (!existingRun) throw new PermanentJobError(`Extraction run ${runId} not found`);
  if (existingRun.status === 'succeeded') {
    logger.info('extraction already saved; nothing to do', { jobId: job.id, runId });
    return;
  }
  if (!claude.isConfigured()) {
    throw new PermanentJobError('ANTHROPIC_API_KEY is not configured', { publicMessage: 'AI extraction is not configured' });
  }

  const meeting = await meetings.findById(meetingId);
  assertCurrent(meeting, await runs.findLatestForMeeting(meetingId), runId);
  const ctx = await loadContext(meetingId, meeting);

  await runs.markRunning(runId, claude.model());
  const response = await claude.extract(ctx.prompt);
  const result = validateExtraction(response.text, ctx.validation);

  const summary = { ...result.summary, rejectedItems: result.rejected, stopReason: response.stopReason };
  const saved = await withTransaction(async (conn) => {
    const current = await meetings.findByIdForUpdate(conn, meetingId);
    assertCurrent(current, await runs.findLatestForMeeting(meetingId, conn), runId);
    const counts = await actionItems.replacePendingExtracted(conn, meetingId, runId, result.items);
    await runs.markSucceeded(conn, runId, {
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      rawResponse: safeJson(response.text),
      summary: { ...summary, replacedPending: counts.deleted },
    });
    await meetings.update(conn, meetingId, { status: 'review_pending', lastError: null });
    return counts;
  });

  await audit({
    action: 'extraction.succeeded',
    entityType: 'meeting',
    entityId: meetingId,
    before: { status: 'extracting' },
    after: { status: 'review_pending', runId, ...result.summary, replacedPending: saved.deleted },
  });
  logger.info('extraction saved', {
    jobId: job.id,
    meetingId,
    runId,
    ...result.summary,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { unparseable: true };
  }
}

async function onFailure(job, err, { final }) {
  const { meetingId, runId } = job.payload;
  await runs.markFailed(runId, String(err.message).slice(0, 2000), { final });
  if (!final) return;

  const publicMessage = err.publicMessage ?? 'AI extraction failed';
  const changed = await withTransaction(async (conn) => {
    const meeting = await meetings.findByIdForUpdate(conn, meetingId);
    const latest = await runs.findLatestForMeeting(meetingId, conn);
    // Only touch the meeting if it is still waiting for this run.
    if (!meeting || meeting.status !== 'extracting' || latest?.id !== runId) return false;
    await meetings.update(conn, meetingId, { status: 'failed', lastError: publicMessage });
    return true;
  });
  if (changed) {
    await audit({
      action: 'extraction.failed',
      entityType: 'meeting',
      entityId: meetingId,
      before: { status: 'extracting' },
      after: { status: 'failed', runId, error: publicMessage },
    });
  }
}

export const aiExtract = { run, onFailure };
