import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

export function toTranscriptSummary(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    segmentCount: row.segment_count,
    detectedLanguages: parseJson(row.detected_languages) ?? [],
    source: row.source ?? null,
    format: row.format ?? null,
    filename: row.filename ?? null,
    fetchedAt: row.fetched_at,
  };
}

export const toSegment = (row) => ({
  id: row.id,
  sourceId: row.vexa_segment_id,
  speaker: row.speaker,
  text: row.text,
  startSec: toNumber(row.start_sec),
  endSec: toNumber(row.end_sec),
  language: row.language,
  confidence: toNumber(row.confidence),
});

// raw_json holds the original upload; only small descriptive fields are extracted here.
// JSON_VALUE returns SQL NULL for JSON null (JSON_UNQUOTE would return the string "null").
const SUMMARY_COLUMNS = `t.id, t.meeting_id, t.segment_count, t.detected_languages, t.fetched_at,
  JSON_VALUE(t.raw_json, '$.source') AS source,
  JSON_VALUE(t.raw_json, '$.format') AS format,
  JSON_VALUE(t.raw_json, '$.filename') AS filename`;

export async function findSummaryByMeeting(meetingId) {
  const [rows] = await pool.execute(`SELECT ${SUMMARY_COLUMNS} FROM transcripts t WHERE t.meeting_id = ?`, [meetingId]);
  return rows[0] ?? null;
}

/** Character count of the transcript text, for the extraction size limit. */
export async function textLength(meetingId, conn = pool) {
  const [rows] = await conn.execute('SELECT CHAR_LENGTH(full_text) AS n, segment_count FROM transcripts WHERE meeting_id = ?', [meetingId]);
  return rows[0] ? { chars: Number(rows[0].n ?? 0), segments: rows[0].segment_count } : null;
}

export async function findSegments(transcriptId) {
  const [rows] = await pool.execute(
    `SELECT id, vexa_segment_id, speaker, text, start_sec, end_sec, language, confidence
     FROM transcript_segments WHERE transcript_id = ? ORDER BY id`,
    [transcriptId],
  );
  return rows;
}

const SEGMENT_BATCH = 500;

/** Deletes any existing transcript for the meeting (segments cascade) and stores the new one. */
export async function replaceForMeeting(conn, meetingId, { fullText, rawJson, detectedLanguages, segments }) {
  await conn.execute('DELETE FROM transcripts WHERE meeting_id = ?', [meetingId]);
  const [result] = await conn.execute(
    `INSERT INTO transcripts (meeting_id, full_text, raw_json, detected_languages, segment_count)
     VALUES (?, ?, ?, ?, ?)`,
    [meetingId, fullText, JSON.stringify(rawJson), JSON.stringify(detectedLanguages), segments.length],
  );
  const transcriptId = result.insertId;

  for (let i = 0; i < segments.length; i += SEGMENT_BATCH) {
    const rows = segments
      .slice(i, i + SEGMENT_BATCH)
      .map((s) => [transcriptId, s.sourceId, s.speaker, s.text, s.startSec, s.endSec, s.language, s.confidence]);
    await conn.query(
      `INSERT INTO transcript_segments
         (transcript_id, vexa_segment_id, speaker, text, start_sec, end_sec, language, confidence)
       VALUES ?`,
      [rows],
    );
  }
  return transcriptId;
}
