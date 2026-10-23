// Employee task portal (Phase 6): the signed-in user's own tasks. The user id always comes
// from the session (req.user), never from the request.
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import * as tasks from '../repositories/tasksRepository.js';
import { recordAudit } from '../services/audit.js';
import { allowedNext, canTransition, isOverdue, summarize } from '../services/tasks.js';
import { localDate } from '../utils/dates.js';
import { AppError, notFound } from '../utils/errors.js';

const today = () => localDate(new Date(), config.extraction.timezone);
const withOverdue = (task, day) => ({ ...task, overdue: isOverdue(task, day), allowedStatuses: allowedNext(task.taskStatus) });
// Same message whether the task doesn't exist, isn't approved, or belongs to someone else.
const taskNotFound = () => notFound('Task not found');

export async function list(req, res) {
  const day = today();
  const all = await tasks.listForUser(req.user.id);
  const filtered = req.query.status ? all.filter((t) => t.taskStatus === req.query.status) : all;
  res.json({
    tasks: filtered.map((t) => withOverdue(t, day)),
    summary: summarize(all, day),
    today: day,
    timezone: config.extraction.timezone,
  });
}

export async function get(req, res) {
  const task = await tasks.findForUser(req.params.id, req.user.id);
  if (!task) throw taskNotFound();
  const [evidence, history] = await Promise.all([tasks.evidenceFor(task.id), tasks.historyFor(task, req.user.id)]);
  res.json({ task: { ...withOverdue(task, today()), evidence, history } });
}

export async function updateStatus(req, res) {
  const { id } = req.params;
  const { status, fromStatus } = req.body;

  // The status change and its audit row commit together, or not at all.
  const updated = await withTransaction(async (conn) => {
    const task = await tasks.findForUser(id, req.user.id, { conn, forUpdate: true });
    if (!task) throw taskNotFound();
    if (fromStatus && fromStatus !== task.taskStatus) {
      throw new AppError(409, 'STALE_STATUS', 'This task was updated elsewhere. Refresh to see its current status.');
    }
    if (!canTransition(task.taskStatus, status)) {
      throw new AppError(409, 'INVALID_TRANSITION', `A task can’t move from “${task.taskStatus}” to “${status}”`);
    }
    await tasks.setStatus(conn, id, status);
    await recordAudit(conn, {
      actorUserId: req.user.id,
      action: 'task.status_changed',
      entityType: 'action_item',
      entityId: id,
      before: { taskStatus: task.taskStatus },
      after: { taskStatus: status },
      ip: req.ip,
    });
    return tasks.findForUser(id, req.user.id, { conn });
  });

  res.json({ task: withOverdue(updated, today()) });
}
