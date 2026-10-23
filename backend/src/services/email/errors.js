import { config } from '../../config/index.js';

/** A failed provider call. `retryable` tells the job queue whether trying again can help. */
export class EmailSendError extends Error {
  constructor(message, { retryable, publicMessage, cause } = {}) {
    super(sanitize(message), { cause });
    this.name = 'EmailSendError';
    this.retryable = retryable;
    this.publicMessage = publicMessage ?? 'The email could not be sent';
  }
}

/** Removes credentials from provider error text before it is logged or stored. */
export function sanitize(text) {
  let out = String(text ?? '');
  for (const secret of [config.email.smtp.pass, config.email.resendApiKey]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/\bre_[A-Za-z0-9_]{8,}/g, '[redacted]') // Resend API keys
    .replace(/(AUTH\s+(?:PLAIN|LOGIN)\s+)\S+/gi, '$1[redacted]')
    .slice(0, 1000);
}
