// Pure translation between Vexa's vocabulary and ours (PLANNING.md: services/vexa/mapper.js).
//
// Vexa meeting statuses (gateway OpenAPI api.v1, MeetingStatus):
//   requested -> joining -> awaiting_admission -> active -> stopping -> completed | failed
//   plus needs_human_help (the bot's lifecycle contract calls it needs_help; both are accepted).

export const VEXA_STATUSES = [
  'requested', 'joining', 'awaiting_admission', 'needs_human_help', 'needs_help', 'active', 'stopping', 'completed', 'failed',
];
export const TERMINAL_VEXA_STATUSES = ['completed', 'failed'];
export const isVexaStatus = (s) => VEXA_STATUSES.includes(s);

/** Our meetings.status for a Vexa status. The lobby is still "joining", not a failure. */
export function toMeetingStatus(vexaStatus) {
  switch (vexaStatus) {
    case 'requested':
      return 'bot_requested';
    case 'joining':
    case 'awaiting_admission':
    case 'needs_human_help':
    case 'needs_help':
      return 'bot_joining';
    case 'active':
    case 'stopping':
      return 'in_progress';
    case 'completed':
      return 'ended';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

// Meeting statuses during which a bot is (or may be) live; requests and uploads are blocked.
export const BOT_ACTIVE_MEETING_STATUSES = ['bot_requested', 'bot_joining', 'in_progress'];

// Vexa completion reasons (MeetingCompletionReason) -> admin-readable text.
const REASONS = {
  stopped: 'Stopped by request',
  left_alone: 'Left because everyone else had left',
  startup_alone: 'Left because nobody joined',
  evicted: 'Removed from the meeting by the host',
  awaiting_admission_timeout: 'Nobody admitted the bot from the lobby in time',
  awaiting_admission_rejected: 'The host declined to admit the bot',
  join_failure: 'The bot could not join the meeting',
  auth_session_missing: 'The bot needed a signed-in Google session',
  validation_error: 'Vexa rejected the meeting details',
  max_bot_time_exceeded: 'Reached the maximum bot time',
  stopped_before_admission: 'Stopped before the bot was admitted',
  stopped_with_no_audio: 'Stopped; no audio was captured',
};
export const describeReason = (reason) => (reason ? REASONS[reason] ?? reason.replaceAll('_', ' ') : null);

/**
 * Google Meet links only (PLANNING.md D3), validated conservatively:
 * https://meet.google.com/abc-defg-hij (optional trailing slash, query or fragment).
 * Returns { platform, nativeMeetingId } or null. Lookup/short links and look-alike hosts are refused.
 */
export function parseGoogleMeetUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port || url.username || url.password) return null;
  const m = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(url.pathname);
  return m ? { platform: 'google_meet', nativeMeetingId: m[1] } : null;
}
