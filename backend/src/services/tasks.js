// Employee task progress (Phase 6). Progress lives in action_items.task_status and is separate
// from the admin review (review_status), which employees can never change.
//
// Visibility: a task is the employee's when it is assigned to their account, approved, and its
// meeting's review is finished (meeting status 'approved' or 'emails_sent'). Anything else is
// treated as not found, so the API never reveals that someone else's task exists.

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const VISIBLE_MEETING_STATUSES = ['approved', 'emails_sent'];

// PLANNING.md: todo -> in_progress -> done | blocked. Employees can also move back (reopen a
// done task, unblock, undo "started"); only a no-op "change" is refused.
const TRANSITIONS = {
  todo: ['in_progress', 'blocked', 'done'],
  in_progress: ['todo', 'blocked', 'done'],
  blocked: ['in_progress', 'todo', 'done'],
  done: ['in_progress', 'todo'],
};

export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;
export const allowedNext = (from) => TRANSITIONS[from] ?? [];

/** Overdue = has a due date before today (in the app timezone) and isn't done. */
export const isOverdue = (task, today) => Boolean(task.dueDate) && task.dueDate < today && task.taskStatus !== 'done';

export function summarize(tasks, today) {
  const count = (status) => tasks.filter((t) => t.taskStatus === status).length;
  return {
    total: tasks.length,
    todo: count('todo'),
    inProgress: count('in_progress'),
    blocked: count('blocked'),
    done: count('done'),
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
  };
}
