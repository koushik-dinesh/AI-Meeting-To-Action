// The only code that knows Vexa's URLs (PLANNING.md §1). Contract: Vexa gateway OpenAPI
// "api.v1" (core/gateway/contracts/api.v1/api.schema.json) plus docs.vexa.ai:
//   POST   /bots                                   -> 201 (body untyped in the spec)
//   GET    /meetings/{id}                          -> MeetingResponse (id integer, status, completion_reason, ...)
//   GET    /transcripts/{platform}/{native_id}     -> TranscriptionResponse (id, status, start/end, segments[])
//   DELETE /bots/{platform}/{native_id}            -> 200
// Auth: X-API-Key. Errors are FastAPI style {"detail": ...}.
// Every response is validated before use; anything unexpected is an `invalid_response` error.
//
// `vexa` is a plain object so tests can point it at a fake fetch; the test suite never calls Vexa.
import { config } from '../../config/index.js';
import { isVexaStatus } from './mapper.js';

export class VexaError extends Error {
  constructor(kind, message, { status, retryable, publicMessage, retryAfterMs } = {}) {
    super(message);
    this.name = 'VexaError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.publicMessage = publicMessage ?? message;
  }
}

const settings = {
  baseUrl: config.vexa.baseUrl,
  apiKey: config.vexa.apiKey,
  timeoutMs: config.vexa.requestTimeoutMs,
};

function detailText(body) {
  const d = body?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((x) => x?.msg ?? JSON.stringify(x)).join('; ');
  if (d && typeof d === 'object') return d.reason ?? d.code ?? JSON.stringify(d);
  return null;
}

function errorFor(status, body, headers) {
  const detail = detailText(body) ?? `HTTP ${status}`;
  const msg = `Vexa ${status}: ${detail}`.slice(0, 500);
  if (status === 401) return new VexaError('auth', msg, { status, retryable: false, publicMessage: 'Vexa rejected the API key (check VEXA_API_KEY)' });
  if (status === 403) {
    // Vexa reports its concurrency limit as 403 {detail: {reason: "concurrency_limit_reached"}}.
    if (body?.detail?.reason === 'concurrency_limit_reached') {
      return new VexaError('busy', msg, { status, retryable: true, publicMessage: 'Vexa is running its maximum number of bots; try again later' });
    }
    return new VexaError('auth', msg, { status, retryable: false, publicMessage: 'The Vexa API key is not allowed to do this (check its scopes)' });
  }
  if (status === 404) return new VexaError('not_found', msg, { status, retryable: false, publicMessage: 'Vexa has no record of this meeting' });
  if (status === 409) return new VexaError('conflict', msg, { status, retryable: false, publicMessage: 'A Vexa bot is already active for this meeting link' });
  if (status === 400 || status === 422) return new VexaError('validation', msg, { status, retryable: false, publicMessage: `Vexa rejected the request: ${detail}` });
  if (status === 429) {
    const retryAfter = Number(headers?.get?.('retry-after'));
    return new VexaError('rate_limited', msg, { status, retryable: true, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined, publicMessage: 'Vexa is rate limiting requests; retrying' });
  }
  if (status === 503) return new VexaError('unavailable', msg, { status, retryable: true, publicMessage: `Vexa is unavailable: ${detail}` });
  return new VexaError('server', msg, { status, retryable: status >= 500, publicMessage: 'Vexa returned an error' });
}

async function request(method, path, body) {
  if (!vexa.isConfigured()) throw new VexaError('not_configured', 'Vexa is not configured', { retryable: false, publicMessage: 'The meeting bot is not configured on the server (VEXA_BASE_URL / VEXA_API_KEY)' });
  let res;
  try {
    res = await vexa.fetch(`${settings.baseUrl}${path}`, {
      method,
      headers: { 'X-API-Key': settings.apiKey, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new VexaError(timeout ? 'timeout' : 'network', `Vexa ${method} ${path} failed: ${err?.message ?? err}`, {
      retryable: true,
      publicMessage: timeout ? 'Vexa did not respond in time' : 'Could not reach Vexa',
    });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok) throw new VexaError('invalid_response', `Vexa ${method} ${path} returned non-JSON`, { status: res.status, retryable: true, publicMessage: 'Vexa returned an unexpected response' });
    }
  }
  if (!res.ok) throw errorFor(res.status, json, res.headers);
  return { status: res.status, body: json };
}

const invalid = (what) => new VexaError('invalid_response', `Unexpected Vexa response: ${what}`, { retryable: true, publicMessage: 'Vexa returned an unexpected response' });
const optionalString = (v) => (typeof v === 'string' && v ? v : null);

/** Fields we use from a MeetingResponse-like object; null-safe for the untyped POST /bots body. */
function meetingFields(m) {
  return {
    id: Number.isSafeInteger(m?.id) ? m.id : null,
    status: isVexaStatus(m?.status) ? m.status : null,
    completionReason: optionalString(m?.completion_reason) ?? optionalString(m?.data?.completion_reason),
    failureStage: optionalString(m?.failure_stage) ?? optionalString(m?.data?.failure_stage),
    startTime: optionalString(m?.start_time),
    endTime: optionalString(m?.end_time),
  };
}

const enc = encodeURIComponent;

export const vexa = {
  settings,
  fetch: (...args) => fetch(...args),
  isConfigured: () => Boolean(settings.baseUrl && settings.apiKey),

  /** POST /bots. The success body is untyped, so the id/status are used only if valid. */
  async requestBot({ platform, nativeMeetingId, botName, language }) {
    const { body } = await request('POST', '/bots', {
      platform,
      native_meeting_id: nativeMeetingId,
      bot_name: botName,
      ...(language && { language }),
    });
    return meetingFields(body);
  },

  /** GET /meetings/{id}: status of one Vexa meeting record. */
  async getMeeting(vexaMeetingId) {
    const { body } = await request('GET', `/meetings/${enc(vexaMeetingId)}`);
    const m = meetingFields(body);
    if (m.id === null || !m.status) throw invalid('meeting without integer id / known status');
    return m;
  },

  /** GET /transcripts/{platform}/{native_meeting_id}: the newest meeting on that link, with segments. */
  async getTranscript(platform, nativeMeetingId) {
    const { body } = await request('GET', `/transcripts/${enc(platform)}/${enc(nativeMeetingId)}`);
    if (!body || typeof body !== 'object' || !Array.isArray(body.segments)) throw invalid('transcript without segments[]');
    for (const s of body.segments) {
      if (!s || typeof s !== 'object' || typeof s.text !== 'string') throw invalid('segment without text');
    }
    const m = meetingFields(body);
    return { ...m, segments: body.segments };
  },

  /** DELETE /bots/{platform}/{native_meeting_id}. The body differs between docs and spec, so it isn't used. */
  async stopBot(platform, nativeMeetingId) {
    await request('DELETE', `/bots/${enc(platform)}/${enc(nativeMeetingId)}`);
  },
};
