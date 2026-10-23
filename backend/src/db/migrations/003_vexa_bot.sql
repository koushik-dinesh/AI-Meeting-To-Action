-- 003_vexa_bot: meeting-bot tracking for the Vexa integration (Phase 7).
-- meetings.status keeps the app's lifecycle (bot_requested, bot_joining, in_progress, ended, ...);
-- these columns hold Vexa's own bot state, which is finer-grained (e.g. awaiting_admission = in
-- the lobby) and is what the admin needs to see. platform / native_meeting_id / vexa_meeting_id
-- already exist from 001.
ALTER TABLE meetings
  ADD COLUMN bot_status       VARCHAR(32) NULL AFTER vexa_meeting_id,
  ADD COLUMN bot_reason       VARCHAR(64) NULL AFTER bot_status,
  ADD COLUMN bot_requested_at DATETIME NULL AFTER bot_reason,
  ADD COLUMN bot_checked_at   DATETIME NULL AFTER bot_requested_at;
