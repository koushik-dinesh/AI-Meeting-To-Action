// Email template and provider adapters (no network: SMTP errors are synthetic, Resend uses a fake fetch).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitize } from '../src/services/email/errors.js';
import { createResendProvider } from '../src/services/email/resendProvider.js';
import { classifySmtpError } from '../src/services/email/smtpProvider.js';
import { renderActionItemsEmail } from '../src/services/email/templates/actionItemsEmail.js';
import { idempotencyKeyFor } from '../src/services/notifications.js';

const items = [
  { title: 'Send <b>deck</b> & notes', description: 'Use the "final" version\n<script>alert(1)</script>', dueDate: '2026-11-06', priority: 'high' },
  { title: 'Book venue', description: null, dueDate: null, priority: 'medium' },
];
const render = (o = {}) =>
  renderActionItemsEmail({
    meeting: { title: 'Launch <sync>\r\nBcc: evil@example.test', scheduledAt: new Date('2026-11-04T10:00:00Z') },
    recipient: { fullName: 'Raj Patel' },
    items,
    appUrl: 'https://app.example.test',
    ...o,
  });

describe('notification email', () => {
  it('escapes all user-controlled content in HTML', () => {
    const { html } = render();
    assert.ok(html.includes('Send &lt;b&gt;deck&lt;/b&gt; &amp; notes'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Use the &quot;final&quot; version'));
    assert.ok(html.includes('Launch &lt;sync&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>deck</b>'));
  });

  it('keeps the subject on one line (no header injection)', () => {
    const { subject } = render();
    assert.ok(!/[\r\n]/.test(subject));
    assert.equal(subject, 'Your action items from "Launch <sync> Bcc: evil@example.test"');
  });

  it('includes meeting, items, due dates and priorities in both versions', () => {
    const { html, text } = render();
    for (const body of [html, text]) {
      assert.match(body, /Fri, 6 Nov 2026/);
      assert.match(body, /No date set|no date set/);
      assert.match(body, /High/);
      assert.match(body, /4 Nov 2026/);
    }
    assert.match(text, /^Hi Raj,/);
    assert.match(text, /1\. Send <b>deck<\/b> & notes/, 'plain text is not HTML-escaped');
    assert.match(text, /2\. Book venue/);
    assert.match(text, /Open Meeting to Action: https:\/\/app\.example\.test\//);
  });

  it('omits the link when no public URL is configured', () => {
    const { html, text } = render({ appUrl: undefined });
    assert.ok(!html.includes('<a '));
    assert.ok(!text.includes('Open Meeting to Action'));
  });

  it('never contains other recipients or email addresses of anyone', () => {
    const { html, text } = render({ meeting: { title: 'Sync', scheduledAt: null } });
    assert.ok(!/@/.test(html) && !/@/.test(text));
  });
});

describe('idempotency key', () => {
  it('depends on meeting, recipient and the set of items, not their order', () => {
    assert.equal(idempotencyKeyFor(1, 2, [5, 3]), idempotencyKeyFor(1, 2, [3, 5]));
    assert.notEqual(idempotencyKeyFor(1, 2, [3, 5]), idempotencyKeyFor(1, 2, [3]));
    assert.notEqual(idempotencyKeyFor(1, 2, [3]), idempotencyKeyFor(1, 4, [3]));
    assert.match(idempotencyKeyFor(1, 2, [3]), /^[0-9a-f]{64}$/);
  });
});

describe('SMTP error classification', () => {
  it('retries 4xx and network errors; fails permanently on 5xx, auth and envelope errors', () => {
    assert.equal(classifySmtpError({ responseCode: 451, response: '451 try later' }).retryable, true);
    assert.equal(classifySmtpError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }).retryable, true);
    assert.equal(classifySmtpError({ responseCode: 550, response: '550 no such user' }).retryable, false);
    assert.equal(classifySmtpError({ responseCode: 535, code: 'EAUTH', response: '535 bad credentials' }).retryable, false);
    assert.equal(classifySmtpError({ code: 'EENVELOPE', message: 'No recipients defined' }).retryable, false);
  });
});

describe('Resend provider', () => {
  const fakeFetch = (status, body, calls) => async (url, init) => {
    calls?.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const msg = { from: 'A <a@example.test>', to: 'b@example.test', subject: 's', html: '<p>h</p>', text: 't', idempotencyKey: 'k'.repeat(64) };

  it('sends with bearer auth and an Idempotency-Key, returning the message id', async () => {
    const calls = [];
    const p = createResendProvider({ apiKey: 're_test_123456789', fetchImpl: fakeFetch(200, { id: 'abc' }, calls) });
    assert.deepEqual(await p.send(msg), { messageId: 'abc', response: 'HTTP 200' });
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.Authorization, 'Bearer re_test_123456789');
    assert.equal(init.headers['Idempotency-Key'], `email-message/${'k'.repeat(64)}`);
    assert.deepEqual(JSON.parse(init.body).to, ['b@example.test']);
  });

  it('classifies errors', async () => {
    const err = async (status, name) => {
      const p = createResendProvider({ apiKey: 'x', fetchImpl: fakeFetch(status, { name, message: 'm' }) });
      return p.send(msg).catch((e) => e);
    };
    assert.equal((await err(429, 'rate_limit_exceeded')).retryable, true);
    assert.equal((await err(503, 'service_unavailable')).retryable, true);
    assert.equal((await err(422, 'validation_error')).retryable, false);
    assert.equal((await err(403, 'validation_error')).retryable, false);
    assert.equal((await err(429, 'daily_quota_exceeded')).retryable, false);
    const network = await createResendProvider({ apiKey: 'x', fetchImpl: async () => { throw new TypeError('fetch failed'); } }).send(msg).catch((e) => e);
    assert.equal(network.retryable, true);
  });
});

describe('sanitize', () => {
  it('removes API keys and SMTP auth payloads', () => {
    assert.equal(sanitize('bad key re_AbCdEf123456789 rejected'), 'bad key [redacted] rejected');
    assert.equal(sanitize('AUTH PLAIN dXNlcjpwYXNz failed'), 'AUTH PLAIN [redacted] failed');
    assert.equal(sanitize('x'.repeat(5000)).length, 1000);
  });
});
