import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as botApi from '../api/bot.js';
import { MeetingBotPanel } from './MeetingBotPanel.jsx';

vi.mock('../api/bot.js');

const view = (o = {}) => ({
  configured: true,
  meetingStatus: 'draft',
  lastError: null,
  linkValid: true,
  canRequest: true,
  cannotRequestReason: null,
  bot: null,
  polling: null,
  transcript: null,
  extraction: null,
  autoExtract: true,
  ...o,
});
const bot = (o = {}) => ({ platform: 'google_meet', nativeMeetingId: 'abc-defg-hij', vexaMeetingId: '501', status: 'requested', reason: null, reasonText: null, requestedAt: '2026-10-22T10:00:00Z', checkedAt: '2026-10-22T10:00:05Z', ...o });

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
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('meeting bot panel', () => {
  it('explains when Vexa is not configured, without a request button', async () => {
    botApi.getBot.mockResolvedValue({ bot: view({ configured: false, canRequest: false }) });
    render(<MeetingBotPanel meetingId={7} />);
    expect(await screen.findByText(/isn’t configured on the server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send bot/ })).toBeNull();
  });

  it('explains an invalid meeting link', async () => {
    botApi.getBot.mockResolvedValue({ bot: view({ linkValid: false, canRequest: false }) });
    render(<MeetingBotPanel meetingId={7} />);
    expect(await screen.findByText(/only join Google Meet links/)).toBeTruthy();
  });

  it('requests a bot once after confirmation and shows success only when the server accepts', async () => {
    const user = userEvent.setup();
    botApi.getBot.mockResolvedValue({ bot: view() });
    const pending = deferred();
    botApi.requestBot.mockReturnValue(pending.promise);
    const onMeetingChanged = vi.fn();
    render(<MeetingBotPanel meetingId={7} onMeetingChanged={onMeetingChanged} />);

    window.confirm.mockReturnValueOnce(false);
    await user.click(await screen.findByRole('button', { name: 'Send bot to meeting' }));
    expect(botApi.requestBot).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send bot to meeting' }));
    await user.click(screen.getByRole('button', { name: 'Requesting…' }));
    expect(botApi.requestBot).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Bot requested\. It will join/)).toBeNull();

    await act(async () => pending.resolve({ bot: view({ meetingStatus: 'bot_requested', canRequest: false, bot: bot() }) }));
    expect(await screen.findByText('Bot requested. It will join shortly.')).toBeTruthy();
    expect(screen.getByText('Bot requested — starting up…')).toBeTruthy();
    expect(onMeetingChanged).toHaveBeenCalled();
  });

  it('shows a failed request clearly', async () => {
    const user = userEvent.setup();
    botApi.getBot.mockResolvedValue({ bot: view() });
    botApi.requestBot.mockRejectedValue(Object.assign(new Error('Vexa rejected the API key (check VEXA_API_KEY)'), { status: 502, code: 'VEXA_AUTH' }));
    render(<MeetingBotPanel meetingId={7} />);
    await user.click(await screen.findByRole('button', { name: 'Send bot to meeting' }));
    expect(await screen.findByText(/Vexa rejected the API key/)).toBeTruthy();
  });

  it('shows the lobby state as a warning, polls, and stops polling once the meeting moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onMeetingChanged = vi.fn();
    botApi.getBot
      .mockResolvedValueOnce({ bot: view({ meetingStatus: 'bot_joining', canRequest: false, bot: bot({ status: 'awaiting_admission' }) }) })
      .mockResolvedValueOnce({ bot: view({ meetingStatus: 'in_progress', canRequest: false, bot: bot({ status: 'active' }) }) })
      .mockResolvedValue({ bot: view({ meetingStatus: 'extracting', canRequest: false, bot: bot({ status: 'completed' }), transcript: { source: 'vexa', segmentCount: 2 } }) });
    render(<MeetingBotPanel meetingId={7} onMeetingChanged={onMeetingChanged} />);

    expect(await screen.findByText(/waiting in the lobby/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop bot' })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('The bot is in the meeting and transcribing.')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText(/Transcript imported from the bot \(2 segments\)/)).toBeTruthy();
    expect(screen.getByText(/AI extraction has been queued/)).toBeTruthy();
    expect(onMeetingChanged).toHaveBeenCalledTimes(2);
    const calls = botApi.getBot.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(botApi.getBot.mock.calls.length).toBe(calls); // stopped
    expect(screen.queryByRole('button', { name: 'Stop bot' })).toBeNull();
  });

  it('shows a waiting state when the meeting ended but the transcript is not ready', async () => {
    botApi.getBot.mockResolvedValue({ bot: view({ meetingStatus: 'ended', canRequest: false, bot: bot({ status: 'completed' }), polling: { status: 'pending', nextCheckAt: null } }) });
    render(<MeetingBotPanel meetingId={7} />);
    expect(await screen.findByText(/Waiting for the transcript/)).toBeTruthy();
  });

  it('shows bot failures with the reason and offers to send it again', async () => {
    botApi.getBot.mockResolvedValue({ bot: view({ meetingStatus: 'failed', canRequest: true, lastError: 'The bot failed: The host declined to admit the bot', bot: bot({ status: 'failed', reasonText: 'The host declined to admit the bot' }) }) });
    render(<MeetingBotPanel meetingId={7} />);
    expect(await screen.findByText('The bot failed: The host declined to admit the bot.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send the bot again' })).toBeTruthy();
  });

  it('stops a live bot after confirmation', async () => {
    const user = userEvent.setup();
    botApi.getBot.mockResolvedValue({ bot: view({ meetingStatus: 'in_progress', canRequest: false, bot: bot({ status: 'active' }) }) });
    botApi.stopBot.mockResolvedValue({ bot: view({ meetingStatus: 'in_progress', canRequest: false, bot: bot({ status: 'stopping' }) }) });
    render(<MeetingBotPanel meetingId={7} />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    expect(botApi.stopBot).toHaveBeenCalledWith(7);
    expect(await screen.findByText('The bot is leaving the meeting…')).toBeTruthy();
  });

  it('asks before replacing an existing manual transcript and reports a conflict error', async () => {
    const user = userEvent.setup();
    botApi.getBot.mockResolvedValue({ bot: view({ meetingStatus: 'transcript_ready', canRequest: false, bot: bot({ status: 'completed' }), transcript: { source: 'manual_upload', segmentCount: 3 } }) });
    botApi.importBotTranscript.mockRejectedValueOnce(Object.assign(new Error('The transcript can’t be replaced at this stage of the review'), { status: 409 }));
    render(<MeetingBotPanel meetingId={7} />);
    expect(await screen.findByText(/already has a transcript/)).toBeTruthy();

    window.confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Replace with Vexa transcript' }));
    expect(botApi.importBotTranscript).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Replace with Vexa transcript' }));
    expect(botApi.importBotTranscript).toHaveBeenCalledWith(7, true);
    expect(await screen.findByText(/can’t be replaced at this stage/)).toBeTruthy();
  });

  it('imports a transcript and reports queued extraction', async () => {
    const user = userEvent.setup();
    botApi.getBot.mockResolvedValue({ bot: view({ meetingStatus: 'ended', canRequest: false, lastError: 'The meeting ended but Vexa produced no transcript.', bot: bot({ status: 'completed' }) }) });
    botApi.importBotTranscript.mockResolvedValue({ outcome: 'saved', extraction: 'queued', bot: view({ meetingStatus: 'extracting', canRequest: false, bot: bot({ status: 'completed' }), transcript: { source: 'vexa', segmentCount: 4 } }) });
    render(<MeetingBotPanel meetingId={7} />);
    await user.click(await screen.findByRole('button', { name: 'Import Vexa transcript' }));
    expect(botApi.importBotTranscript).toHaveBeenCalledWith(7, false);
    expect(await screen.findByText('Transcript imported. AI extraction has been queued.')).toBeTruthy();
  });
});
