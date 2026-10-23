import * as queue from '../jobs/queue.js';
import * as actionItems from '../repositories/actionItemsRepository.js';
import * as runs from '../repositories/extractionRunsRepository.js';
import * as meetings from '../repositories/meetingsRepository.js';
import { FLAGS } from '../services/ai/validator.js';
import { audit } from '../services/audit.js';
import { requestExtraction } from '../services/extraction.js';
import { notFound } from '../utils/errors.js';

// The extraction checks and EXTRACTABLE_STATUSES live in services/extraction.js (shared with the Vexa pipeline).
export { dedupeKeyFor } from '../services/extraction.js';

/** Latest run plus its job's queue state, for status polling. */
export async function extractionStatus(meetingId) {
  const row = await runs.findLatestForMeeting(meetingId);
  if (!row) return null;
  const run = runs.toRun(row);
  const job = run.jobId ? await queue.findById(run.jobId) : null;
  return {
    ...run,
    job: job && { id: job.id, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, nextRunAt: job.status === 'pending' ? job.runAt : null },
  };
}

export async function extract(req, res) {
  const { id } = req.params;
  const result = await requestExtraction(id, { requestedBy: req.user.id });

  await audit({
    actorUserId: req.user.id,
    action: 'extraction.requested',
    entityType: 'meeting',
    entityId: id,
    before: { status: result.previousStatus },
    after: { status: 'extracting', runId: result.runId, jobId: result.jobId },
    ip: req.ip,
  });
  res.status(202).json({ extraction: await extractionStatus(id) });
}

export async function listActionItems(req, res) {
  const { id } = req.params;
  if (!(await meetings.findById(id))) throw notFound('Meeting not found');
  const [items, extraction] = await Promise.all([actionItems.listForMeeting(id), extractionStatus(id)]);
  res.json({ actionItems: items, extraction, flagDescriptions: FLAGS });
}
