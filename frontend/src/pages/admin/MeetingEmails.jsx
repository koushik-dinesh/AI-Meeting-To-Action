import { useCallback, useEffect, useRef, useState } from 'react';
import { listEmails, previewEmails, retryEmail, sendEmails } from '../../api/emails.js';
import { Button, ErrorAlert, Loading, SuccessAlert } from '../../components/ui.jsx';
import { formatDate, formatDateTime } from '../../utils/format.js';

const POLL_MS = 3000;
const ACTIVE = ['queued', 'sending', 'retry'];
const STATUS = {
  queued: { label: 'Queued', cls: 'bg-sky-100 text-sky-800' },
  sending: { label: 'Sending…', cls: 'bg-sky-100 text-sky-800' },
  retry: { label: 'Retrying', cls: 'bg-amber-100 text-amber-800' },
  sent: { label: 'Sent', cls: 'bg-emerald-100 text-emerald-800' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-700' },
};

function ErrorWithDetails({ error }) {
  return (
    <>
      {error.message}
      {error.details?.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Notification emails for a reviewed meeting: preview -> explicit confirm -> per-recipient status.
 * The backend decides recipients and is the source of truth for every status shown here.
 */
export function MeetingEmails({ meeting, onMeetingChanged }) {
  const [preview, setPreview] = useState(null);
  const [messages, setMessages] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [notice, setNotice] = useState('');
  const [retrying, setRetrying] = useState({}); // messageId -> true
  const [retryErrors, setRetryErrors] = useState({});
  const wasActive = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [p, l] = await Promise.all([previewEmails(meeting.id), listEmails(meeting.id)]);
      setPreview(p);
      setMessages(l.messages);
    } catch (err) {
      setLoadError(err);
    }
  }, [meeting.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any message is still on its way; refresh the meeting once they all settle.
  const active = messages?.some((m) => ACTIVE.includes(m.status)) ?? false;
  useEffect(() => {
    if (!active) {
      if (wasActive.current) {
        wasActive.current = false;
        onMeetingChanged?.();
      }
      return undefined;
    }
    wasActive.current = true;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const l = await listEmails(meeting.id);
        if (!cancelled) setMessages(l.messages);
      } catch (err) {
        if (!cancelled) setLoadError(err);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, messages, meeting.id, onMeetingChanged]);

  if (loadError && !preview) return <ErrorAlert error={`Could not load notifications: ${loadError.message}`} />;
  if (!preview || !messages) return <Loading label="Loading notifications…" />;

  const newRecipients = preview.recipients.filter((r) => !r.existingMessage);

  async function send() {
    if (sending || newRecipients.length === 0) return;
    const names = newRecipients.map((r) => r.recipient.fullName).join(', ');
    if (!window.confirm(`Send ${newRecipients.length} email${newRecipients.length === 1 ? '' : 's'} to ${names}?`)) return;
    setSending(true);
    setSendError(null);
    setNotice('');
    try {
      const result = await sendEmails(meeting.id);
      setMessages(result.messages);
      setNotice(result.queued ? `${result.queued} email${result.queued === 1 ? '' : 's'} queued for sending.` : 'These emails were already requested.');
      setPreview(await previewEmails(meeting.id));
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  }

  async function retry(message) {
    if (retrying[message.id]) return;
    setRetrying((r) => ({ ...r, [message.id]: true }));
    setRetryErrors((e) => ({ ...e, [message.id]: null }));
    try {
      await retryEmail(message.id);
      const l = await listEmails(meeting.id);
      setMessages(l.messages);
    } catch (err) {
      setRetryErrors((e) => ({ ...e, [message.id]: err }));
    } finally {
      setRetrying((r) => ({ ...r, [message.id]: false }));
    }
  }

  return (
    <div className="space-y-5">
      {!preview.emailConfigured && (newRecipients.length > 0 || messages.some((m) => m.status === 'failed')) && (
        <ErrorAlert error="Email sending isn’t configured on the server (EMAIL_PROVIDER / EMAIL_FROM). Notifications can’t be sent yet." />
      )}

      {/* Preview */}
      {newRecipients.length > 0 && (
        <section aria-label="Email preview" className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ready to send</h3>
          <ul className="space-y-2">
            {newRecipients.map((r) => (
              <li key={r.recipient.id} className="rounded-md border border-slate-200 px-3 py-2">
                <p className="text-sm font-medium text-slate-900">
                  {r.recipient.fullName} <span className="font-normal text-slate-500">· {r.recipient.email}</span>
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
                  {r.items.map((i) => (
                    <li key={i.id} className="break-words">
                      • {i.title}
                      <span className="text-xs text-slate-500">
                        {' '}
                        — {i.dueDate ? `due ${formatDate(i.dueDate)}` : 'no due date'}, {i.priority} priority
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <Button onClick={send} disabled={sending || !preview.emailConfigured}>
            {sending ? 'Sending…' : `Send ${newRecipients.length} email${newRecipients.length === 1 ? '' : 's'}`}
          </Button>
        </section>
      )}

      {preview.recipients.length === 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No approved action item has an active assignee with an email address, so there is nobody to notify.
        </p>
      )}

      {preview.excluded.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">Not included:</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.excluded.map((e) => (
              <li key={e.itemId} className="break-words">
                {e.title} — {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.notApproved.rejected > 0 && (
        <p className="text-xs text-slate-500">
          {preview.notApproved.rejected} rejected item{preview.notApproved.rejected === 1 ? ' is' : 's are'} never emailed.
        </p>
      )}

      <SuccessAlert>{notice}</SuccessAlert>
      {sendError && <ErrorAlert error={<ErrorWithDetails error={sendError} />} />}

      {/* Status */}
      {messages.length > 0 && (
        <section aria-label="Email status" className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery</h3>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {messages.map((m) => {
              const s = STATUS[m.status];
              return (
                <li key={m.id} className="space-y-1 px-3 py-2" aria-label={`Email to ${m.recipient.fullName}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-words text-sm">
                      <span className="font-medium text-slate-900">{m.recipient.fullName}</span>{' '}
                      <span className="text-slate-500">
                        · {m.items.length} item{m.items.length === 1 ? '' : 's'}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
                      {m.status === 'failed' && (
                        <Button variant="secondary" className="!px-2 !py-1 text-xs" disabled={retrying[m.id]} onClick={() => retry(m)}>
                          {retrying[m.id] ? 'Retrying…' : 'Retry'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {m.status === 'sent' && m.sentAt && <p className="text-xs text-slate-500">Accepted by the mail server {formatDateTime(m.sentAt)}</p>}
                  {m.status === 'retry' && m.nextAttemptAt && (
                    <p className="text-xs text-amber-700">
                      {m.lastError}. Next attempt {formatDateTime(m.nextAttemptAt)}.
                    </p>
                  )}
                  {m.status === 'failed' && m.lastError && <p className="text-xs text-red-700">{m.lastError}</p>}
                  {retryErrors[m.id] && <ErrorAlert error={<ErrorWithDetails error={retryErrors[m.id]} />} />}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-slate-500">“Sent” means the mail server accepted the message; it doesn’t guarantee it reached the inbox.</p>
        </section>
      )}
    </div>
  );
}
