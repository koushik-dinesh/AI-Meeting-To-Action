// Resend via its REST API (https://resend.com/docs/api-reference/emails/send-email):
// POST https://api.resend.com/emails, "Authorization: Bearer <key>", JSON {from, to, subject, html, text},
// success -> {"id": "..."}. The Idempotency-Key header (max 256 chars, remembered 24h) makes a
// repeated send of the same message a no-op on Resend's side.
// Sending to arbitrary recipients needs a verified domain in EMAIL_FROM.
import { EmailSendError } from './errors.js';

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 30_000;
// 429 rate/quota, 409 concurrent request with the same key / resource locked, 5xx server side.
const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504]);
const PERMANENT_NAMES = new Set(['invalid_idempotent_request', 'daily_quota_exceeded', 'monthly_quota_exceeded']);

export function createResendProvider({ apiKey, fetchImpl = fetch }) {
  return {
    name: 'resend',
    async send({ from, to, subject, html, text, idempotencyKey }) {
      let res;
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `email-message/${idempotencyKey}`,
          },
          body: JSON.stringify({ from, to: [to], subject, html, text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new EmailSendError(`Resend request failed: ${err.name}: ${err.message}`, {
          retryable: true,
          publicMessage: 'Could not reach the email service',
          cause: err,
        });
      }

      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) return { messageId: body.id, response: `HTTP ${res.status}` };

      const name = body.name ?? 'unknown_error';
      const detail = `Resend ${res.status} ${name}: ${body.message ?? res.statusText}`;
      const retryable = RETRYABLE_STATUS.has(res.status) && !PERMANENT_NAMES.has(name);
      throw new EmailSendError(detail, {
        retryable,
        publicMessage: retryable ? 'The email service is busy; retrying' : 'The email service rejected the message',
      });
    },
  };
}
