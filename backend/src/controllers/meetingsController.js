import { withTransaction } from '../db/transaction.js';
import { extractionStatus } from './extractionController.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { audit } from '../services/audit.js';
import { badRequest, notFound } from '../utils/errors.js';

const toParticipant = (row) => ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  role: row.role,
  isActive: Boolean(row.is_active),
});

async function assertActiveUsers(userIds) {
  const unique = [...new Set(userIds)];
  const found = new Set(await users.findActiveIds(unique));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw badRequest('Some participants are not active users', missing.map((id) => ({ field: 'participantIds', message: `User ${id} not found or inactive` })));
  }
  return unique;
}

async function loadDetail(id) {
  const row = await meetings.findById(id);
  if (!row) throw notFound('Meeting not found');
  const [participants, transcript, extraction] = await Promise.all([
    meetings.listParticipants(id),
    transcripts.findSummaryByMeeting(id),
    extractionStatus(id),
  ]);
  return {
    ...meetings.toMeeting(row),
    participants: participants.map(toParticipant),
    transcript: transcript ? transcripts.toTranscriptSummary(transcript) : null,
    extraction,
  };
}

export async function list(req, res) {
  const { rows, total } = await meetings.list(req.query);
  res.json({ meetings: rows.map(meetings.toMeeting), total, limit: req.query.limit, offset: req.query.offset });
}

export async function get(req, res) {
  res.json({ meeting: await loadDetail(req.params.id) });
}

export async function create(req, res) {
  const { participantIds = [], ...fields } = req.body;
  const userIds = await assertActiveUsers(participantIds);

  const id = await withTransaction(async (conn) => {
    const meetingId = await meetings.create(conn, { ...fields, createdBy: req.user.id });
    await meetings.replaceParticipants(conn, meetingId, userIds);
    return meetingId;
  });

  const meeting = await loadDetail(id);
  await audit({ actorUserId: req.user.id, action: 'meeting.created', entityType: 'meeting', entityId: id, after: meeting, ip: req.ip });
  res.status(201).json({ meeting });
}

export async function update(req, res) {
  const { id } = req.params;
  const { participantIds, ...fields } = req.body;
  const before = await loadDetail(id);
  const userIds = participantIds ? await assertActiveUsers(participantIds) : null;

  await withTransaction(async (conn) => {
    await meetings.update(conn, id, fields);
    if (userIds) await meetings.replaceParticipants(conn, id, userIds);
  });

  const after = await loadDetail(id);
  await audit({ actorUserId: req.user.id, action: 'meeting.updated', entityType: 'meeting', entityId: id, before, after, ip: req.ip });
  res.json({ meeting: after });
}
