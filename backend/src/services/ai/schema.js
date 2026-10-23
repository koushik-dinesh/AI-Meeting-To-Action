// Structured-output contract between Claude and the backend.
//
// OUTPUT_FORMAT is sent to the API (output_config.format) so Claude's response is
// constrained to this shape. It is written by hand using only features structured outputs
// support (types, enum, nullable via anyOf, required, additionalProperties: false). The API
// does not enforce numeric or length limits, so the stricter rules live in ItemSchema, which
// validator.js applies to every item.
import { z } from 'zod';

export const PRIORITIES = ['low', 'medium', 'high'];
export const MAX_ITEMS = 100;
export const MAX_TITLE = 255;
export const MAX_DESCRIPTION = 5000;
export const MAX_QUOTE = 2000;

const str = (description) => ({ type: 'string', ...(description && { description }) });
const nullableStr = (description) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], ...(description && { description }) });
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const EVIDENCE_JSON = object({
  segment_ref: str('The reference of the transcript line, e.g. "S12"'),
  speaker: nullableStr('Speaker label of that line'),
  timestamp: nullableStr('Timestamp of that line, e.g. "00:12"'),
  quote: str('Words copied verbatim from that line'),
});

const ITEM_JSON = object({
  title: str('Short imperative task title'),
  description: str('What has to be done, preserving the meaning of the conversation'),
  assignee_name_raw: nullableStr('Owner name exactly as said or as the speaker label; null if nobody took or was given it'),
  assignee_confidence: { type: 'number', description: '0 to 1' },
  due_date_raw: nullableStr('Deadline words exactly as said; null if none was stated'),
  due_date_resolved: nullableStr('YYYY-MM-DD only if the deadline is unambiguous given the meeting date; else null'),
  due_date_is_ambiguous: { type: 'boolean' },
  priority: { type: 'string', enum: PRIORITIES },
  ai_confidence: { type: 'number', description: '0 to 1: how clearly this was agreed as an action' },
  needs_review_reason: nullableStr('Why a human should double-check this item; null if nothing is uncertain'),
  evidence: { type: 'array', items: EVIDENCE_JSON },
});

/** Value for output_config.format on messages.create / stream. */
export const OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: object({ action_items: { type: 'array', items: ITEM_JSON } }),
};

// ---------- stricter validation, applied by validator.js ----------

const confidence = z.number().min(0).max(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const EvidenceSchema = z.object({
  segment_ref: z.string().trim().max(20),
  speaker: z.string().max(200).nullable(),
  timestamp: z.string().max(20).nullable(),
  quote: z.string().trim().min(1).max(MAX_QUOTE),
});

export const ItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  description: z.string().trim(),
  assignee_name_raw: z.string().trim().max(200).nullable(),
  assignee_confidence: confidence,
  due_date_raw: z.string().trim().max(200).nullable(),
  due_date_resolved: isoDate.nullable(),
  due_date_is_ambiguous: z.boolean(),
  priority: z.enum(PRIORITIES),
  ai_confidence: confidence,
  needs_review_reason: z.string().max(1000).nullable(),
  evidence: z.array(z.unknown()).max(20),
});

/** Top level only; items are validated one by one so one bad item doesn't drop the rest. */
export const EnvelopeSchema = z.object({ action_items: z.array(z.unknown()).max(MAX_ITEMS) });
