// SMTP via nodemailer. Works with Mailpit locally (127.0.0.1:1025, no auth).
import nodemailer from 'nodemailer';
import { EmailSendError } from './errors.js';

// Network-level failures worth retrying.
const TRANSIENT_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'EPIPE']);

export function classifySmtpError(err) {
  const code = err?.responseCode;
  const detail = `SMTP ${code ?? err?.code ?? 'error'}: ${err?.response ?? err?.message ?? err}`;
  if (code >= 400 && code < 500) {
    return new EmailSendError(detail, { retryable: true, publicMessage: 'The mail server asked us to try again later', cause: err });
  }
  if (code === 535 || code === 534 || err?.code === 'EAUTH') {
    return new EmailSendError(detail, { retryable: false, publicMessage: 'The mail server rejected our login (check SMTP settings)', cause: err });
  }
  if (code >= 500 || err?.code === 'EENVELOPE') {
    return new EmailSendError(detail, { retryable: false, publicMessage: 'The mail server rejected the message or recipient address', cause: err });
  }
  if (TRANSIENT_CODES.has(err?.code)) {
    return new EmailSendError(detail, { retryable: true, publicMessage: 'Could not reach the mail server', cause: err });
  }
  return new EmailSendError(detail, { retryable: true, publicMessage: 'Sending failed unexpectedly', cause: err });
}

export function createSmtpProvider({ host, port, secure, user, pass }) {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    name: 'smtp',
    /** Resolves when the server accepts the message (not proof of inbox delivery). */
    async send({ from, to, subject, html, text, idempotencyKey }) {
      let info;
      try {
        info = await transport.sendMail({
          from,
          to,
          subject,
          html,
          text,
          // Stable Message-ID: if a message is ever re-sent, mail clients can recognise the duplicate.
          messageId: `<${idempotencyKey}@meeting-to-action>`,
        });
      } catch (err) {
        throw classifySmtpError(err);
      }
      if (info.rejected?.length) {
        throw new EmailSendError(`SMTP rejected recipient(s): ${info.rejected.join(', ')}`, {
          retryable: false,
          publicMessage: 'The mail server rejected the recipient address',
        });
      }
      return { messageId: info.messageId, response: String(info.response ?? '').slice(0, 200) };
    },
  };
}
