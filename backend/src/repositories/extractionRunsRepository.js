import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// raw_response is deliberately not exposed through the API; it stays in the database for debugging.
export const toRun = (row) => ({
  id: row.id,
  meetingId: row.meeting_id,
  jobId: row.job_id,
  requestedBy: row.requested_by,
  model: row.model,
  promptVersion: row.prompt_version,
  status: row.status,
  attempts: row.attempts,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  summary: parseJson(row.summary),
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export async function create(conn, { meetingId, requestedBy, model, promptVersion }) {
  const [result] = await conn.execute(
    `INSERT INTO extraction_runs (meeting_id, requested_by, model, prompt_version, status)
     VALUES (?, ?, ?, ?, 'queued')`,
    [meetingId, requestedBy, model, promptVersion],
  );
  return result.insertId;
}

export async function setJob(conn, runId, jobId) {
  await conn.execute('UPDATE extraction_runs SET job_id = ? WHERE id = ?', [jobId, runId]);
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.execute('SELECT * FROM extraction_runs WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function findLatestForMeeting(meetingId, conn = pool) {
  const [rows] = await conn.execute(
    'SELECT * FROM extraction_runs WHERE meeting_id = ? ORDER BY id DESC LIMIT 1',
    [meetingId],
  );
  return rows[0] ?? null;
}

export async function markRunning(id, model) {
  await pool.execute(
    `UPDATE extraction_runs SET status = 'running', model = ?, attempts = attempts + 1,
            started_at = COALESCE(started_at, NOW()), error = NULL
     WHERE id = ?`,
    [model, id],
  );
}

export async function markSucceeded(conn, id, { model, inputTokens, outputTokens, rawResponse, summary }) {
  await conn.execute(
    `UPDATE extraction_runs SET status = 'succeeded', model = ?, input_tokens = ?, output_tokens = ?,
            raw_response = ?, summary = ?, error = NULL, finished_at = NOW()
     WHERE id = ?`,
    [model, inputTokens, outputTokens, JSON.stringify(rawResponse), JSON.stringify(summary), id],
  );
}

/** final=false: the job will retry, so the run goes back to 'queued' with the error noted. */
export async function markFailed(id, error, { final }) {
  await pool.execute(
    `UPDATE extraction_runs SET status = ?, error = ?, finished_at = IF(?, NOW(), NULL)
     WHERE id = ? AND status <> 'succeeded'`,
    [final ? 'failed' : 'queued', error, final, id],
  );
}
