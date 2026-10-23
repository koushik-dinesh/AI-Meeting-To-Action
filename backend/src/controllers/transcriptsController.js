import { withTransaction } from '../db/transaction.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import { audit } from '../services/audit.js';
import { TranscriptParseError, parseTranscript, renderFullText } from '../services/transcripts/parser.js';
import { AppError, badRequest, conflict, notFound, payloadTooLarge } from '../utils/errors.js';

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.txt', '.vtt', '.srt', '.json'];

// A manual transcript may be (re)placed until AI extraction starts working from it.
// Statuses where a bot is active, or extraction/review/email has begun, are locked.
const REPLACEABLE_STATUSES = ['draft', 'ended', 'transcript_ready', 'failed'];

function checkUpload({ content, filename }) {
  if (filename) {
    const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Only ${ALLOWED_EXTENSIONS.join(', ')} files are supported`);
    }
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw payloadTooLarge(`Transcript exceeds ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB`);
  }
  // Text formats only: NUL bytes or many replacement characters mean a binary file was read as text.
  const replacementChars = content.match(/�/g)?.length ?? 0;
  if (content.includes('\u0000') || replacementChars > 20) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'The file does not look like UTF-8 text');
  }
}

export async function upload(req, res) {
  const { id } = req.params;
  const { content, format, filename } = req.body;
  checkUpload(req.body);

  let parsed;
  try {
    parsed = parseTranscript(content, { format, filename });
  } catch (err) {
    if (err instanceof TranscriptParseError) throw badRequest(err.message);
    throw err;
  }

  const detectedLanguages = [...new Set(parsed.segments.map((s) => s.language).filter(Boolean))];
  // The original upload is kept so it can be re-parsed later; never interpreted beyond parsing.
  const rawJson = {
    source: 'manual_upload',
    format: parsed.format,
    filename: filename ?? null,
    uploadedBy: req.user.id,
    ...(parsed.raw !== undefined ? { data: parsed.raw } : { content }),
  };

  const previousStatus = await withTransaction(async (conn) => {
    const meeting = await meetings.findByIdForUpdate(conn, id);
    if (!meeting) throw notFound('Meeting not found');
    if (!REPLACEABLE_STATUSES.includes(meeting.status)) {
      throw conflict(`A transcript cannot be uploaded while the meeting is "${meeting.status}"`);
    }
    await transcripts.replaceForMeeting(conn, id, {
      fullText: renderFullText(parsed.segments),
      rawJson,
      detectedLanguages,
      segments: parsed.segments,
    });
    await meetings.update(conn, id, { status: 'transcript_ready' });
    return meeting.status;
  });

  const summary = transcripts.toTranscriptSummary(await transcripts.findSummaryByMeeting(id));
  await audit({
    actorUserId: req.user.id,
    action: 'transcript.uploaded',
    entityType: 'meeting',
    entityId: id,
    before: { status: previousStatus },
    after: { status: 'transcript_ready', format: parsed.format, filename: filename ?? null, segmentCount: summary.segmentCount },
    ip: req.ip,
  });
  res.status(201).json({ transcript: summary, meeting: { id, status: 'transcript_ready' } });
}

export async function get(req, res) {
  const summary = await transcripts.findSummaryByMeeting(req.params.id);
  if (!summary) {
    if (!(await meetings.findById(req.params.id))) throw notFound('Meeting not found');
    throw notFound('This meeting has no transcript yet');
  }
  const segments = await transcripts.findSegments(summary.id);
  res.json({ transcript: transcripts.toTranscriptSummary(summary), segments: segments.map(transcripts.toSegment) });
}
