import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderTranscript } from '../src/services/ai/extractionPrompt.js';
import { InvalidAiResponseError, validateExtraction } from '../src/services/ai/validator.js';
import { buildDirectory } from '../src/services/matching/assigneeMatcher.js';
import { parseTranscript } from '../src/services/transcripts/parser.js';

const text = readFileSync(new URL('./fixtures/english-standup.txt', import.meta.url), 'utf8');
const segments = parseTranscript(text).segments.map((s, i) => ({ ...s, id: 100 + i }));
const { refs } = renderTranscript(segments);
const directory = buildDirectory(
  [
    { id: 1, fullName: 'Jane Liu', isActive: true },
    { id: 2, fullName: 'Raj Patel', isActive: true },
    { id: 3, fullName: 'Sam Lee', isActive: true },
    { id: 4, fullName: 'Priya Shah', isActive: true },
  ],
  [],
);
const ctx = (extra = {}) => ({ refs, segments, directory, refDate: '2026-11-04', existing: [], ...extra });

const item = (overrides = {}) => ({
  title: 'Send final pricing deck to sales',
  description: 'Raj will send the final pricing deck to the sales team.',
  assignee_name_raw: 'Raj Patel',
  assignee_confidence: 0.95,
  due_date_raw: 'by Friday',
  due_date_resolved: '2026-11-06',
  due_date_is_ambiguous: false,
  priority: 'medium',
  ai_confidence: 0.9,
  needs_review_reason: null,
  evidence: [{ segment_ref: 'S2', speaker: 'Raj Patel', timestamp: '00:20', quote: "I'll send the final pricing deck to the sales team by Friday" }],
  ...overrides,
});
const run = (items, c = ctx()) => validateExtraction(JSON.stringify({ action_items: items }), c);

describe('response shape', () => {
  it('accepts a valid structured response', () => {
    const { items, rejected, summary } = run([item()]);
    assert.equal(rejected.length, 0);
    assert.equal(items.length, 1);
    const [i] = items;
    assert.equal(i.assigneeUserId, 2);
    assert.equal(i.assigneeMatch, 'exact');
    assert.equal(i.dueDate, '2026-11-06');
    assert.deepEqual(i.flags, []);
    assert.deepEqual(i.evidence, [{ excerpt: "I'll send the final pricing deck to the sales team by Friday", speaker: 'Raj Patel', startSec: 20, segmentId: 101 }]);
    assert.deepEqual(summary, { returned: 1, saved: 1, rejected: 0, merged: 0, flagged: 0, unassigned: 0 });
  });

  it('rejects malformed responses as a whole', () => {
    assert.throws(() => validateExtraction('not json', ctx()), InvalidAiResponseError);
    assert.throws(() => validateExtraction('{"items": []}', ctx()), InvalidAiResponseError);
    assert.throws(() => validateExtraction('{"action_items": "none"}', ctx()), InvalidAiResponseError);
  });

  it('accepts an empty list', () => {
    assert.equal(run([]).items.length, 0);
  });
});

describe('item validation', () => {
  const rejectedFor = (overrides) => {
    const { items, rejected } = run([item(overrides)]);
    assert.equal(items.length, 0);
    assert.equal(rejected.length, 1);
    return rejected[0].reasons.join('; ');
  };

  it('rejects missing required fields', () => {
    const bad = item();
    delete bad.priority;
    delete bad.ai_confidence;
    const { rejected } = run([bad]);
    assert.match(rejected[0].reasons.join(), /priority/);
    assert.match(rejected[0].reasons.join(), /ai_confidence/);
    assert.match(rejectedFor({ title: '   ' }), /Title is required/);
  });

  it('rejects an invalid priority', () => {
    assert.match(rejectedFor({ priority: 'urgent' }), /priority/);
  });

  it('rejects confidences outside 0..1 or of the wrong type', () => {
    assert.match(rejectedFor({ ai_confidence: 1.5 }), /ai_confidence/);
    assert.match(rejectedFor({ assignee_confidence: -0.1 }), /assignee_confidence/);
    assert.match(rejectedFor({ ai_confidence: '0.9' }), /ai_confidence/);
  });

  it('rejects items without evidence', () => {
    assert.match(rejectedFor({ evidence: [] }), /No evidence provided/);
  });

  it('rejects items whose evidence is not in the transcript', () => {
    assert.match(
      rejectedFor({ evidence: [{ segment_ref: 'S2', speaker: 'Raj Patel', timestamp: null, quote: 'We approved the marketing budget yesterday' }] }),
      /could be found/,
    );
  });

  it('corrects a wrong segment ref when a long quote is found elsewhere, and drops unverified quotes', () => {
    const { items } = run([
      item({
        evidence: [
          { segment_ref: 'S9', speaker: null, timestamp: null, quote: 'send the final pricing deck' },
          { segment_ref: 'S2', speaker: null, timestamp: null, quote: 'this sentence was never said' },
        ],
      }),
    ]);
    assert.equal(items[0].evidence.length, 1);
    assert.equal(items[0].evidence[0].segmentId, 101);
    assert.ok(items[0].flags.includes('some_evidence_unverified'));
    assert.equal(items[0].reviewDetails.evidence.refsCorrected, 1);
  });

  it('accepts quotes with ellipses and different punctuation/case', () => {
    const { items } = run([item({ evidence: [{ segment_ref: 'S2', speaker: null, timestamp: null, quote: "I'LL SEND the final pricing deck … by friday!" }] })]);
    assert.equal(items.length, 1);
  });

  it('truncates over-long titles and descriptions', () => {
    const { items } = run([item({ title: 'x'.repeat(300), description: 'y'.repeat(6000) })]);
    assert.equal(items[0].title.length, 255);
    assert.equal(items[0].description.length, 5000);
    assert.ok(items[0].flags.includes('title_truncated'));
    assert.ok(items[0].flags.includes('description_truncated'));
  });

  it('flags low AI confidence and AI review notes', () => {
    const { items } = run([item({ ai_confidence: 0.3, needs_review_reason: 'Unclear if agreed' })]);
    assert.ok(items[0].flags.includes('low_confidence'));
    assert.ok(items[0].flags.includes('ai_review_note'));
  });
});

describe('assignee checks', () => {
  it('does not assign names that never occur in the transcript', () => {
    const { items } = run([item({ assignee_name_raw: 'Sam Lee' }), item({ title: 'Other', assignee_name_raw: 'admin@example.test' })]);
    assert.equal(items[0].assigneeUserId, 3, 'Sam Lee is a speaker label');
    assert.equal(items[1].assigneeUserId, null);
  });

  it('flags a name absent from the transcript even if it is a registered user', () => {
    const { items } = run([item({ assignee_name_raw: 'Priya Shah' })]);
    assert.equal(items[0].assigneeUserId, null);
    assert.deepEqual(items[0].flags, ['assignee_not_in_transcript']);
  });

  it('flags uncertain ownership from the AI', () => {
    const { items } = run([item({ assignee_confidence: 0.4 })]);
    assert.equal(items[0].assigneeUserId, 2);
    assert.ok(items[0].flags.includes('uncertain_assignee'));
  });
});

describe('deadline checks', () => {
  const deadline = (overrides, c) => run([item(overrides)], c).items[0];

  it('keeps ambiguous deadlines unresolved', () => {
    const i = deadline({
      due_date_raw: 'next Friday',
      due_date_resolved: '2026-11-13',
      evidence: [{ segment_ref: 'S8', speaker: 'Priya', timestamp: null, quote: "I'll update the onboarding docs next Friday" }],
    });
    assert.equal(i.dueDate, null);
    assert.equal(i.dueDateRaw, 'next Friday');
    assert.ok(i.flags.includes('ambiguous_deadline'));
  });

  it('trusts Claude ambiguity even when the parser could resolve', () => {
    const i = deadline({ due_date_is_ambiguous: true });
    assert.equal(i.dueDate, null);
    assert.ok(i.flags.includes('ambiguous_deadline'));
  });

  it('nulls the date when parser and AI disagree', () => {
    const i = deadline({ due_date_resolved: '2026-11-13' });
    assert.equal(i.dueDate, null);
    assert.ok(i.flags.includes('deadline_conflict'));
  });

  it('flags missing deadlines and invented deadlines', () => {
    assert.ok(deadline({ due_date_raw: null, due_date_resolved: null }).flags.includes('missing_deadline'));
    const invented = deadline({ due_date_raw: 'by December 1st', due_date_resolved: '2026-12-01' });
    assert.equal(invented.dueDate, null);
    assert.ok(invented.flags.includes('deadline_not_in_transcript'));
  });

  it('does not resolve relative deadlines without a meeting date', () => {
    const i = deadline({}, ctx({ refDate: null }));
    assert.equal(i.dueDate, null);
    assert.ok(i.flags.includes('deadline_unresolved_no_meeting_date'));
  });
});

describe('duplicates', () => {
  it('merges near-identical items in one response', () => {
    const { items, summary } = run([item(), item({ title: 'Send the final pricing deck to sales team', ai_confidence: 0.97 })]);
    assert.equal(items.length, 1);
    assert.equal(items[0].aiConfidence, 0.97);
    assert.ok(items[0].flags.includes('merged_duplicates'));
    assert.equal(summary.merged, 1);
  });

  it('keeps distinct tasks by the same person', () => {
    const { items } = run([
      item(),
      item({
        title: 'Book the launch venue',
        assignee_name_raw: 'Sam Lee',
        evidence: [{ segment_ref: 'S4', speaker: 'Sam Lee', timestamp: null, quote: "I'll book the venue by the end of the month" }],
        due_date_raw: 'by the end of the month',
        due_date_resolved: '2026-11-30',
      }),
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[1].dueDate, '2026-11-30');
  });

  it('skips items that duplicate an already reviewed item', () => {
    const { items, rejected } = run([item()], ctx({ existing: [{ id: 7, title: 'Send final pricing deck to sales', assigneeUserId: 2, assigneeNameRaw: 'Raj Patel' }] }));
    assert.equal(items.length, 0);
    assert.match(rejected[0].reasons[0], /#7/);
  });
});
