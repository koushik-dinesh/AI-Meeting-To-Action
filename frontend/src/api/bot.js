import { api } from './client.js';

// Vexa meeting bot (Phase 7). The browser only talks to our API; Vexa is server-side.
export const getBot = (meetingId) => api(`/meetings/${meetingId}/bot`);
export const requestBot = (meetingId) => api(`/meetings/${meetingId}/bot`, { method: 'POST' });
export const stopBot = (meetingId) => api(`/meetings/${meetingId}/bot`, { method: 'DELETE' });
export const checkBot = (meetingId) => api(`/meetings/${meetingId}/bot/check`, { method: 'POST' });
export const importBotTranscript = (meetingId, replace = false) =>
  api(`/meetings/${meetingId}/transcript/refresh`, { method: 'POST', body: { replace } });
