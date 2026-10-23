import { useState } from 'react';
import { updateMyTaskStatus } from '../../api/tasks.js';
import { Button, ErrorAlert } from '../ui.jsx';

export const STATUS_LABEL = { todo: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Completed' };
const STATUS_STYLE = {
  todo: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-sky-100 text-sky-800',
  blocked: 'bg-amber-100 text-amber-800',
  done: 'bg-emerald-100 text-emerald-800',
};
export const PRIORITY_STYLE = { high: 'bg-rose-100 text-rose-700', medium: 'bg-slate-100 text-slate-700', low: 'bg-slate-100 text-slate-500' };

export function TaskStatusBadge({ status }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

// Button label for moving from `from` to `to`.
function actionLabel(from, to) {
  if (to === 'done') return 'Mark complete';
  if (to === 'blocked') return 'Mark blocked';
  if (to === 'todo') return 'Mark not started';
  if (from === 'done') return 'Reopen';
  if (from === 'blocked') return 'Resume';
  return 'Start';
}
const ORDER = ['in_progress', 'done', 'blocked', 'todo'];

/**
 * Status buttons for the transitions the server allows (task.allowedStatuses). The new status
 * is shown only after the server confirms it; while a request runs all buttons are disabled.
 */
export function TaskStatusControl({ task, onUpdated, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function change(status) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { task: updated } = await updateMyTaskStatus(task.id, status, task.taskStatus);
      await onUpdated(updated);
    } catch (err) {
      setError(err.code === 'STALE_STATUS' ? `${err.message}` : err);
    } finally {
      setBusy(false);
    }
  }

  const options = ORDER.filter((s) => task.allowedStatuses?.includes(s));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Update status of ${task.title}`}>
        {options.map((s, i) => (
          <Button
            key={s}
            variant={i === 0 ? 'primary' : 'secondary'}
            className={compact ? '!px-2.5 !py-1.5 text-xs' : ''}
            disabled={busy}
            onClick={() => change(s)}
          >
            {actionLabel(task.taskStatus, s)}
          </Button>
        ))}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}
