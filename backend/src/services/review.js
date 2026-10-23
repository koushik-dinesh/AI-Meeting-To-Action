// Review rules for action items (Phase 4). Pure functions; the controller applies them
// inside a transaction.
//
// - Flags come from validator.js. They are removed only by an explicit admin decision:
//     setting an assignee resolves the assignee flags, setting a due date resolves the
//     deadline flags, editing the title/description resolves the truncation flags, and any
//     other flag is resolved by listing it in `resolveFlags`. Each resolution is recorded in
//     review_details.resolvedFlags.
// - An item can be approved only when it has an active assignee and no unresolved flags
//   other than the informational ones (INFO_FLAGS).
// - Review status: pending -> approved | rejected; approved | rejected -> pending (reopen).
//   Only pending items can be edited.

import { FLAGS } from './ai/validator.js';

export const ASSIGNEE_FLAGS = [
  'missing_assignee', 'unknown_assignee', 'ambiguous_assignee', 'inactive_assignee',
  'assignee_first_name_only', 'assignee_not_in_transcript', 'uncertain_assignee',
];
export const DEADLINE_FLAGS = [
  'missing_deadline', 'ambiguous_deadline', 'deadline_conflict', 'deadline_needs_confirmation',
  'deadline_unresolved_no_meeting_date', 'deadline_not_in_transcript', 'deadline_in_past',
];
// Shown to the reviewer but never block approval.
export const INFO_FLAGS = ['missing_deadline', 'merged_duplicates'];

// Meeting statuses in which items may be added, edited or reviewed. Not while 'extracting'
// (the worker is about to replace pending AI items) and not after review is finished.
export const REVIEWABLE_MEETING_STATUSES = ['transcript_ready', 'review_pending', 'failed'];

const TRANSITIONS = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  reopen: { from: ['approved', 'rejected'], to: 'pending' },
};

export class ReviewRuleError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

/** Returns the target status, or throws if the action isn't allowed from `current`. */
export function transition(action, current) {
  const t = TRANSITIONS[action];
  if (!t.from.includes(current)) throw new ReviewRuleError(`Cannot ${action} an item that is ${current}`);
  return t.to;
}

/**
 * Applies an admin edit. `item` is the current row in API shape (flags, reviewDetails…);
 * `changes` is the validated PATCH body. Returns the column values to write.
 */
export function applyEdit(item, changes, { actorId, now = new Date() }) {
  const flags = new Set(item.flags);
  const resolved = [];
  const resolve = (codes, reason) => {
    for (const code of codes) {
      if (flags.delete(code)) resolved.push({ code, reason, by: actorId, at: now.toISOString() });
    }
  };

  const out = {};
  if (changes.title !== undefined && changes.title !== item.title) {
    out.title = changes.title;
    resolve(['title_truncated'], 'Title edited');
  }
  if (changes.description !== undefined && changes.description !== item.description) {
    out.description = changes.description;
    resolve(['description_truncated'], 'Description edited');
  }
  if (changes.priority !== undefined) out.priority = changes.priority;

  if (changes.assigneeUserId !== undefined) {
    out.assigneeUserId = changes.assigneeUserId;
    out.assigneeMatch = changes.assigneeUserId ? 'manual' : 'none';
    if (changes.assigneeUserId) resolve(ASSIGNEE_FLAGS, 'Assignee chosen by admin');
  }
  if (changes.dueDate !== undefined) {
    out.dueDate = changes.dueDate;
    if (changes.dueDate) resolve(DEADLINE_FLAGS, 'Due date set by admin');
  }

  for (const code of changes.resolveFlags ?? []) {
    if (!flags.has(code)) throw new ReviewRuleError(`Flag "${code}" is not open on this item`);
    resolve([code], 'Marked resolved by admin');
  }

  out.flags = [...flags];
  if (resolved.length) {
    out.reviewDetails = { ...(item.reviewDetails ?? {}), resolvedFlags: [...(item.reviewDetails?.resolvedFlags ?? []), ...resolved] };
  }
  return out;
}

/** Reasons the item can't be approved yet (empty array = approvable). */
export function approvalProblems(item) {
  const problems = [];
  if (!item.assignee) problems.push('Choose an assignee');
  else if (!item.assignee.isActive) problems.push(`${item.assignee.fullName} is inactive; choose another assignee`);
  for (const flag of item.flags.filter((f) => !INFO_FLAGS.includes(f))) {
    problems.push(`Resolve the flag “${FLAGS[flag] ?? flag.replaceAll('_', ' ')}”`);
  }
  return problems;
}
