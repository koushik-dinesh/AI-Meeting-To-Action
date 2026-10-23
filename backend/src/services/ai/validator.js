// Deterministic validation of Claude's extraction output. Nothing Claude returns is trusted:
// every item is re-checked against the stored transcript and the user directory.
//
// Validation policy
// - Response not JSON / wrong top-level shape  -> InvalidAiResponseError (job retries, then fails).
// - Item fails the schema (missing field, bad priority, confidence outside 0..1, …) -> rejected.
// - Evidence: each quote must be found verbatim (case/punctuation/whitespace-insensitive) in the
//   referenced transcript segment, or in another segment for quotes of 12+ characters (the ref
//   is then corrected). Unverifiable quotes are discarded. An item with no verified evidence is
//   rejected: we never store a task the transcript can't be shown to support.
// - Assignee: matched by assigneeMatcher; a name that doesn't occur in the transcript (text or
//   speaker labels) is not assigned. Uncertain matches are flagged, never guessed.
// - Deadline: the raw words must occur in the transcript. due_date is set only when the
//   deterministic resolver and Claude agree, or Claude resolved a phrase the resolver can't read
//   (flagged for confirmation). Ambiguous, conflicting, past or unresolvable deadlines stay null.
// - Duplicates: near-identical items in one response are merged; items matching an already
//   approved/rejected item of the meeting are skipped.
// - Over-long title/description are truncated and flagged.
import { normalizeName } from '../matching/normalize.js';
import { matchAssignee } from '../matching/assigneeMatcher.js';
import { addDays, daysBetween, isValidIsoDate, resolveDeadline } from '../../utils/dates.js';
import { EnvelopeSchema, EvidenceSchema, ItemSchema, MAX_DESCRIPTION, MAX_TITLE } from './schema.js';

export const FLAGS = {
  missing_assignee: 'No owner was named',
  unknown_assignee: 'Owner does not match any registered user',
  ambiguous_assignee: 'Owner name matches several users',
  inactive_assignee: 'Owner matches an inactive user',
  assignee_first_name_only: 'Owner matched by first name only',
  assignee_not_in_transcript: 'Owner name does not occur in the transcript',
  uncertain_assignee: 'AI was unsure who owns this',
  missing_deadline: 'No deadline was stated',
  ambiguous_deadline: 'Deadline is vague or ambiguous',
  deadline_conflict: 'AI and date parser disagree on the deadline',
  deadline_needs_confirmation: 'Deadline resolved by AI only',
  deadline_unresolved_no_meeting_date: 'Relative deadline but the meeting date is unknown',
  deadline_not_in_transcript: 'Deadline words do not occur in the transcript',
  deadline_in_past: 'Resolved deadline is before the meeting',
  some_evidence_unverified: 'Some quoted evidence was not found in the transcript',
  low_confidence: 'AI is not confident this was an agreed action',
  ai_review_note: 'AI asked for a human check',
  merged_duplicates: 'Merged from several near-identical items',
  title_truncated: 'Title was shortened',
  description_truncated: 'Description was shortened',
};

export class InvalidAiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAiResponseError';
    this.retryable = true; // a fresh attempt usually returns a valid response
    this.publicMessage = 'The AI returned an invalid response';
  }
}

// Comparison form for quotes: case-, accent-, punctuation- and whitespace-insensitive.
const forMatch = (s) => ` ${normalizeName(s ?? '')} `;
const MIN_GLOBAL_QUOTE = 12;
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'and', 'of', 'for', 'on', 'in', 'by', 'with', 'up', 'out']);

function titleTokens(title) {
  return new Set(normalizeName(title).split(' ').filter((t) => t && !STOPWORDS.has(t)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Parses the model's JSON text and checks the top-level shape. */
export function parseEnvelope(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InvalidAiResponseError('AI response is not valid JSON');
  }
  const result = EnvelopeSchema.safeParse(data);
  if (!result.success) throw new InvalidAiResponseError(`AI response has the wrong shape: ${result.error.issues[0]?.message}`);
  return result.data.action_items;
}

function verifyEvidence(entries, ctx) {
  const verified = [];
  let unverified = 0;
  let corrected = 0;
  for (const entry of entries) {
    const parsed = EvidenceSchema.safeParse(entry);
    if (!parsed.success) {
      unverified++;
      continue;
    }
    const { segment_ref: ref, quote } = parsed.data;
    const fragments = quote
      .split(/\.{3}|…/)
      .map(forMatch)
      .filter((f) => f.trim().length >= 3);
    if (fragments.length === 0) {
      unverified++;
      continue;
    }
    const contains = (segment) => fragments.every((f) => forMatch(segment.text).includes(f));

    let segment = ctx.refs.get(ref.replace(/^\[|\]$/g, ''));
    if (!segment || !contains(segment)) {
      const long = fragments.join('').trim().length >= MIN_GLOBAL_QUOTE;
      const found = long ? ctx.segments.find(contains) : undefined;
      if (found) corrected++;
      segment = found;
    }
    if (!segment) {
      unverified++;
      continue;
    }
    if (verified.some((v) => v.segmentId === segment.id)) continue;
    verified.push({ excerpt: quote.trim(), speaker: segment.speaker, startSec: segment.startSec ?? null, segmentId: segment.id });
  }
  return { verified, unverified, corrected };
}

function checkDeadline(item, ctx) {
  const raw = item.due_date_raw?.trim() || null;
  if (!raw) return { dueDate: null, dueDateRaw: null, flags: ['missing_deadline'], reason: 'No deadline stated' };
  const out = (dueDate, flags, reason) => ({ dueDate, dueDateRaw: raw, flags, reason, aiResolved: item.due_date_resolved });

  if (!ctx.transcriptMatchText.includes(forMatch(raw))) {
    return out(null, ['deadline_not_in_transcript'], 'Deadline words not found in transcript');
  }
  const ours = resolveDeadline(raw, ctx.refDate);
  const aiDate = isValidIsoDate(item.due_date_resolved) ? item.due_date_resolved : null;

  if (ours.ambiguous || item.due_date_is_ambiguous) {
    if (!ctx.refDate && ours.recognized && !ours.date) {
      return out(null, ['deadline_unresolved_no_meeting_date'], 'Meeting date unknown');
    }
    return out(null, ['ambiguous_deadline'], 'Deadline is ambiguous');
  }

  let date;
  let flags = [];
  let reason;
  if (ours.date) {
    if (aiDate && aiDate !== ours.date) return out(null, ['deadline_conflict'], `Parser: ${ours.date}, AI: ${aiDate}`);
    date = ours.date;
    reason = 'Resolved from meeting date';
  } else if (aiDate && ctx.refDate) {
    date = aiDate;
    flags = ['deadline_needs_confirmation'];
    reason = 'Resolved by AI only';
  } else {
    return out(null, [ctx.refDate ? 'ambiguous_deadline' : 'deadline_unresolved_no_meeting_date'], 'Could not resolve deadline');
  }

  if (ctx.refDate) {
    if (daysBetween(ctx.refDate, date) < 0) return out(null, ['deadline_in_past'], `${date} is before the meeting`);
    if (date > addDays(ctx.refDate, 730)) return out(null, ['ambiguous_deadline'], `${date} is implausibly far out`);
  }
  return out(date, flags, reason);
}

function checkAssignee(item, ctx) {
  const name = item.assignee_name_raw?.trim() || null;
  if (name && !ctx.transcriptNames.some((n) => n.includes(forMatch(name)))) {
    return {
      userId: null,
      match: 'none',
      flags: ['assignee_not_in_transcript'],
      details: { nameRaw: name, aiConfidence: item.assignee_confidence, candidates: [], reason: 'Name not found in transcript' },
    };
  }
  const m = matchAssignee(name, ctx.directory);
  const flags = [...m.flags];
  if (name && item.assignee_confidence < 0.6) flags.push('uncertain_assignee');
  return {
    userId: m.userId,
    match: m.match,
    flags,
    details: {
      nameRaw: name,
      aiConfidence: item.assignee_confidence,
      matchConfidence: m.confidence,
      candidates: m.candidates.map(({ id, fullName, isActive }) => ({ id, fullName, isActive })),
      reason: m.reason,
    },
  };
}

function validateItem(raw, index, ctx) {
  const parsed = ItemSchema.safeParse(raw);
  if (!parsed.success) {
    return { rejected: { index, title: typeof raw?.title === 'string' ? raw.title.slice(0, 120) : null, reasons: parsed.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`) } };
  }
  const item = parsed.data;
  const flags = [];

  const evidence = verifyEvidence(item.evidence, ctx);
  if (evidence.verified.length === 0) {
    return {
      rejected: {
        index,
        title: item.title.slice(0, 120),
        reasons: [item.evidence.length ? 'No evidence quote could be found in the transcript' : 'No evidence provided'],
      },
    };
  }
  if (evidence.unverified) flags.push('some_evidence_unverified');

  let title = item.title;
  if (title.length > MAX_TITLE) {
    title = `${title.slice(0, MAX_TITLE - 1)}…`;
    flags.push('title_truncated');
  }
  let description = item.description;
  if (description.length > MAX_DESCRIPTION) {
    description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
    flags.push('description_truncated');
  }

  const assignee = checkAssignee(item, ctx);
  const deadline = checkDeadline(item, ctx);
  flags.push(...assignee.flags, ...deadline.flags);
  if (item.ai_confidence < 0.5) flags.push('low_confidence');
  if (item.needs_review_reason) flags.push('ai_review_note');

  return {
    item: {
      title,
      description: description || null,
      assigneeNameRaw: item.assignee_name_raw?.trim() || null,
      assigneeUserId: assignee.userId,
      assigneeMatch: assignee.match,
      dueDate: deadline.dueDate,
      dueDateRaw: deadline.dueDateRaw,
      priority: item.priority,
      aiConfidence: item.ai_confidence,
      flags: [...new Set(flags)],
      evidence: evidence.verified,
      reviewDetails: {
        assignee: assignee.details,
        deadline: { raw: deadline.dueDateRaw, aiResolved: item.due_date_resolved, aiAmbiguous: item.due_date_is_ambiguous, reason: deadline.reason },
        evidence: { provided: item.evidence.length, verified: evidence.verified.length, refsCorrected: evidence.corrected },
        aiNote: item.needs_review_reason,
      },
    },
  };
}

const sameOwner = (a, b) =>
  (a.assigneeUserId && a.assigneeUserId === b.assigneeUserId) ||
  normalizeName(a.assigneeNameRaw ?? '') === normalizeName(b.assigneeNameRaw ?? '');

function isDuplicate(a, b) {
  if (!sameOwner(a, b)) return false;
  const sim = jaccard(titleTokens(a.title), titleTokens(b.title));
  if (sim >= 0.7) return true;
  const sharedEvidence = a.evidence.some((e) => b.evidence.some((f) => f.segmentId === e.segmentId));
  return sharedEvidence && sim >= 0.4;
}

function mergeInto(target, dup) {
  for (const e of dup.evidence) if (!target.evidence.some((t) => t.segmentId === e.segmentId)) target.evidence.push(e);
  target.aiConfidence = Math.max(target.aiConfidence, dup.aiConfidence);
  if (!target.flags.includes('merged_duplicates')) target.flags.push('merged_duplicates');
  target.reviewDetails.mergedCount = (target.reviewDetails.mergedCount ?? 1) + 1;
}

/**
 * @param text Claude's JSON text
 * @param ctx  { refs: Map<ref, segment>, segments: [{id, speaker, text, startSec}], directory,
 *               refDate: 'YYYY-MM-DD'|null, existing: [{id, title, assigneeUserId, assigneeNameRaw}] }
 * @returns {{ items, rejected, summary }}
 */
export function validateExtraction(text, ctx) {
  const rawItems = parseEnvelope(text);
  const fullCtx = {
    ...ctx,
    transcriptMatchText: forMatch(ctx.segments.map((s) => s.text).join(' ')),
    transcriptNames: [forMatch(ctx.segments.map((s) => `${s.speaker ?? ''} ${s.text}`).join(' '))],
  };

  const items = [];
  const rejected = [];
  let merged = 0;
  rawItems.forEach((raw, index) => {
    const result = validateItem(raw, index, fullCtx);
    if (result.rejected) return rejected.push(result.rejected);

    const existing = (ctx.existing ?? []).find((e) => isDuplicate({ ...e, evidence: [] }, result.item));
    if (existing) {
      return rejected.push({ index, title: result.item.title.slice(0, 120), reasons: [`Duplicate of already reviewed item #${existing.id}`] });
    }
    const dup = items.find((i) => isDuplicate(i, result.item));
    if (dup) {
      mergeInto(dup, result.item);
      merged++;
      return;
    }
    items.push(result.item);
  });

  return {
    items,
    rejected,
    summary: {
      returned: rawItems.length,
      saved: items.length,
      rejected: rejected.length,
      merged,
      flagged: items.filter((i) => i.flags.some((f) => f !== 'missing_deadline')).length,
      unassigned: items.filter((i) => !i.assigneeUserId).length,
    },
  };
}
