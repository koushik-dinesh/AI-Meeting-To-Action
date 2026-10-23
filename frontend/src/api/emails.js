import { api } from './client.js';

// Email notifications (Phase 5). Recipients are decided by the server; the client never sends addresses.
export const previewEmails = (meetingId) => api(`/meetings/${meetingId}/emails/preview`);
export const sendEmails = (meetingId) => api(`/meetings/${meetingId}/send-emails`, { method: 'POST' });
export const listEmails = (meetingId) => api(`/meetings/${meetingId}/emails`);
export const retryEmail = (messageId) => api(`/emails/${messageId}/retry`, { method: 'POST' });
