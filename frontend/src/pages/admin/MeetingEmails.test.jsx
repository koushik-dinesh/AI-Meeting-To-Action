import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as emailsApi from '../../api/emails.js';
import { MeetingEmails } from './MeetingEmails.jsx';

vi.mock('../../api/emails.js');

const meeting = { id: 7, status: 'approved' };
const raj = { id: 2, fullName: 'Raj Patel', email: 'raj@example.test' };
const sam = { id: 3, fullName: 'Sam Lee', email: 'sam@example.test' };

const previewOf = (o = {}) => ({
  meetingStatus: 'approved',
  canSend: true,
  emailConfigured: true,
  recipients: [
    { recipient: raj, items: [{ id: 1, title: 'Send the deck', dueDate: '2026-11-06', priority: 'high' }, { id: 2, title: 'Update pricing', dueDate: null, priority: 'medium' }], existingMessage: null },
    { recipient: sam, items: [{ id: 3, title: 'Book the venue', dueDate: null, priority: 'medium' }], existingMessage: null },
  ],
  excluded: [{ itemId: 4, title: 'Nobody owns this', reason: 'No assignee' }],
  notApproved: { pending: 0, rejected: 1 },
  ...o,
});
const message = (recipient, status, o = {}) => ({ id: recipient.id * 10, recipient, status, items: [{ id: 1, title: 'x' }], lastError: null, sentAt: null, nextAttemptAt: null, ...o });

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('email notifications panel', () => {
  it('previews recipients with their items and explains exclusions', async () => {
    emailsApi.previewEmails.mockResolvedValue(previewOf());
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    render(<MeetingEmails meeting={meeting} />);
    const preview = await screen.findByRole('region', { name: 'Email preview' });
    expect(within(preview).getByText(/Raj Patel/)).toBeTruthy();
    expect(within(preview).getByText(/raj@example\.test/)).toBeTruthy();
    expect(within(preview).getByText(/Send the deck/)).toBeTruthy();
    expect(within(preview).getByText(/Book the venue/)).toBeTruthy();
    expect(screen.getByText(/Nobody owns this — No assignee/)).toBeTruthy();
    expect(screen.getByText(/1 rejected item is never emailed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 2 emails' })).toBeTruthy();
  });

  it('warns when there is nobody to notify', async () => {
    emailsApi.previewEmails.mockResolvedValue(previewOf({ recipients: [] }));
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    render(<MeetingEmails meeting={meeting} />);
    expect(await screen.findByText(/there is nobody to notify/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });

  it('warns and disables sending when email is not configured, but only if something is left to send', async () => {
    emailsApi.previewEmails.mockResolvedValue(previewOf({ emailConfigured: false }));
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    render(<MeetingEmails meeting={meeting} />);
    expect(await screen.findByText(/isn’t configured on the server/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 2 emails' }).disabled).toBe(true);
    cleanup();

    emailsApi.previewEmails.mockResolvedValue(previewOf({ emailConfigured: false, recipients: [] }));
    emailsApi.listEmails.mockResolvedValue({ messages: [message(raj, 'sent')] });
    render(<MeetingEmails meeting={meeting} />);
    await screen.findByRole('region', { name: 'Email status' });
    expect(screen.queryByText(/isn’t configured on the server/)).toBeNull();
  });

  it('asks for confirmation, sends once, and reports success only after the server accepts', async () => {
    const user = userEvent.setup();
    emailsApi.previewEmails
      .mockResolvedValueOnce(previewOf())
      .mockResolvedValue(previewOf({ recipients: previewOf().recipients.map((r) => ({ ...r, existingMessage: { id: 1, status: 'queued' } })) }));
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    const pending = deferred();
    emailsApi.sendEmails.mockReturnValue(pending.promise);
    render(<MeetingEmails meeting={meeting} />);

    window.confirm.mockReturnValueOnce(false);
    await user.click(await screen.findByRole('button', { name: 'Send 2 emails' }));
    expect(emailsApi.sendEmails).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send 2 emails' }));
    expect(window.confirm).toHaveBeenLastCalledWith('Send 2 emails to Raj Patel, Sam Lee?');
    await user.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(emailsApi.sendEmails).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/queued for sending/)).toBeNull();

    await act(async () => pending.resolve({ queued: 2, alreadyRequested: 0, messages: [message(raj, 'sent', { sentAt: '2026-11-04T12:00:00Z' }), message(sam, 'sent')] }));
    expect(await screen.findByText('2 emails queued for sending.')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'Email to Raj Patel' })).getByText('Sent')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Email preview' })).toBeNull();
  });

  it('shows a send error with details', async () => {
    const user = userEvent.setup();
    emailsApi.previewEmails.mockResolvedValue(previewOf());
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    emailsApi.sendEmails.mockRejectedValue(Object.assign(new Error('Finish reviewing the action items before sending notifications'), { status: 409 }));
    render(<MeetingEmails meeting={meeting} />);
    await user.click(await screen.findByRole('button', { name: 'Send 2 emails' }));
    expect(await screen.findByText(/Finish reviewing/)).toBeTruthy();
  });

  it('shows per-recipient status, polls while sending, and refreshes the meeting when done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onMeetingChanged = vi.fn();
    emailsApi.previewEmails.mockResolvedValue(previewOf({ recipients: [] }));
    emailsApi.listEmails
      .mockResolvedValueOnce({ messages: [message(raj, 'sent', { sentAt: '2026-11-04T12:00:00Z' }), message(sam, 'retry', { lastError: 'The mail server asked us to try again later', nextAttemptAt: '2026-11-04T12:01:00Z' })] })
      .mockResolvedValue({ messages: [message(raj, 'sent'), message(sam, 'sent')] });
    render(<MeetingEmails meeting={meeting} onMeetingChanged={onMeetingChanged} />);

    const samRow = await screen.findByRole('listitem', { name: 'Email to Sam Lee' });
    expect(within(samRow).getByText('Retrying')).toBeTruthy();
    expect(within(samRow).getByText(/try again later\. Next attempt/)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await within(screen.getByRole('listitem', { name: 'Email to Sam Lee' })).findByText('Sent')).toBeTruthy();
    expect(onMeetingChanged).toHaveBeenCalledTimes(1);
    const calls = emailsApi.listEmails.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(emailsApi.listEmails.mock.calls.length).toBe(calls); // polling stopped
  });

  it('retries a failed email once per click and shows retry errors', async () => {
    const user = userEvent.setup();
    emailsApi.previewEmails.mockResolvedValue(previewOf({ recipients: [] }));
    emailsApi.listEmails.mockResolvedValue({ messages: [message(raj, 'sent'), message(sam, 'failed', { lastError: 'The mail server rejected the message or recipient address' })] });
    const pending = deferred();
    emailsApi.retryEmail.mockReturnValueOnce(pending.promise);
    render(<MeetingEmails meeting={meeting} />);

    const samRow = await screen.findByRole('listitem', { name: 'Email to Sam Lee' });
    expect(within(samRow).getByText(/rejected the message/)).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'Email to Raj Patel' })).queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(within(samRow).getByRole('button', { name: 'Retry' }));
    await user.click(within(samRow).getByRole('button', { name: 'Retrying…' }));
    expect(emailsApi.retryEmail).toHaveBeenCalledTimes(1);
    expect(emailsApi.retryEmail).toHaveBeenCalledWith(30);
    await act(async () => pending.reject(Object.assign(new Error('This email is already being sent'), { status: 409 })));
    expect(await within(samRow).findByText('This email is already being sent')).toBeTruthy();
  });

  it('shows a load error', async () => {
    emailsApi.previewEmails.mockRejectedValue(new Error('Cannot reach the server. Is the backend running?'));
    emailsApi.listEmails.mockResolvedValue({ messages: [] });
    render(<MeetingEmails meeting={meeting} />);
    expect(await screen.findByText(/Could not load notifications: Cannot reach the server/)).toBeTruthy();
  });
});
