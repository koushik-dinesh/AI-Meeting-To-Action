import { useState } from 'react';
import { startExtraction } from '../../api/meetings.js';
import { formatDateTime } from '../../utils/format.js';
import { Button, ErrorAlert } from '../ui.jsx';

// Must match EXTRACTABLE_STATUSES in backend controllers/extractionController.js.
export const EXTRACTABLE = ['transcript_ready', 'review_pending', 'failed'];

/** Which extraction state to show, derived from the meeting as the backend reports it. */
export function extractionState(meeting) {
  const run = meeting.extraction;
  if (meeting.status === 'approved' || meeting.status === 'emails_sent') return 'reviewed';
  if (meeting.status === 'extracting') return run?.status === 'running' ? 'processing' : 'queued';
  if (!meeting.transcript) return 'no_transcript';
  if (!run) return 'not_started';
  if (run.status === 'failed' || meeting.status === 'failed') return 'failed';
  return 'done';
}

export function ExtractionPanel({ meeting, pendingAiItems, onStarted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const state = extractionState(meeting);
  const run = meeting.extraction;
  const canStart = Boolean(meeting.transcript) && EXTRACTABLE.includes(meeting.status);

  async function start() {
    if (busy || !canStart) return;
    if (pendingAiItems > 0 && !window.confirm(`Run extraction again? The ${pendingAiItems} AI suggestion(s) still waiting for review, including your edits to them, will be replaced. Approved, rejected and manual items are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      await startExtraction(meeting.id);
      await onStarted();
    } catch (err) {
      setError(err.code === 'AI_NOT_CONFIGURED' ? 'AI extraction isn’t configured on the server. Ask an administrator to set ANTHROPIC_API_KEY.' : err);
    } finally {
      setBusy(false);
    }
  }

  const startButton = (label) =>
    canStart && (
      <Button onClick={start} disabled={busy}>
        {busy ? 'Starting…' : label}
      </Button>
    );

  return (
    <div className="space-y-3" aria-live="polite">
      {state === 'no_transcript' && <p className="text-sm text-slate-500">Upload a transcript to extract action items.</p>}

      {state === 'not_started' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">No extraction has been run for this meeting yet.</p>
          {startButton('Extract action items')}
        </div>
      )}

      {(state === 'queued' || state === 'processing') && (
        <div className="flex items-start gap-3 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900" role="status">
          <span className="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
          <div>
            <p className="font-medium">{state === 'queued' ? 'Extraction queued…' : 'Extracting action items…'}</p>
            <p className="text-sky-800">
              This usually takes under a minute. This page updates automatically.
              {run?.job?.attempts > 0 && run?.job?.status === 'pending' && run.error && ` A temporary error occurred; retrying${run.job.nextRunAt ? ` at ${formatDateTime(run.job.nextRunAt)}` : ''}.`}
            </p>
          </div>
        </div>
      )}

      {state === 'failed' && (
        <div className="space-y-2">
          <ErrorAlert error={`Extraction failed: ${meeting.lastError ?? 'unknown error'}`} />
          <div className="flex justify-end">{startButton('Try again')}</div>
        </div>
      )}

      {state === 'done' && run && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            Extracted {formatDateTime(run.finishedAt ?? run.createdAt)}
            {run.summary && ` · ${run.summary.saved} suggested${run.summary.rejected ? `, ${run.summary.rejected} discarded (no verifiable evidence or duplicates)` : ''}`}
          </p>
          {startButton('Run extraction again')}
        </div>
      )}

      {state === 'reviewed' && <p className="text-sm text-emerald-700">Review finished. Approved items are ready for notification.</p>}

      <ErrorAlert error={error} />
    </div>
  );
}
