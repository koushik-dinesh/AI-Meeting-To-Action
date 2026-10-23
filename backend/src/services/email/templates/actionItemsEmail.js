// Action-item notification email (HTML + plain text). Everything user-controlled is escaped;
// only the recipient's own approved items are passed in. No transcript text, AI output or
// other recipients appear in the message.

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Header-safe single line (no CR/LF injection into the Subject header).
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

function formatDue(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatMeetingDate(instant, timeZone) {
  if (!instant) return null;
  // dateStyle/timeStyle can't be combined with timeZoneName, so the fields are explicit.
  return new Date(instant).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}

/**
 * @param meeting   { title, scheduledAt }
 * @param recipient { fullName }
 * @param items     [{ title, description, dueDate, priority }]  approved, assigned to this recipient
 * @param appUrl    validated public base URL, or undefined (then no link is included)
 */
export function renderActionItemsEmail({ meeting, recipient, items, appUrl, timeZone = 'UTC' }) {
  const title = oneLine(meeting.title);
  const when = formatMeetingDate(meeting.scheduledAt, timeZone);
  const count = items.length;
  const subject = oneLine(`Your action item${count === 1 ? '' : 's'} from "${title}"`).slice(0, 255);
  const firstName = oneLine(recipient.fullName).split(' ')[0] || 'there';

  // ---------- plain text ----------
  const textItems = items
    .map((item, i) => {
      const lines = [`${i + 1}. ${oneLine(item.title)}`];
      if (item.description) lines.push(`   ${item.description.trim().replace(/\n/g, '\n   ')}`);
      const due = formatDue(item.dueDate);
      lines.push(`   Due: ${due ?? 'no date set'} · Priority: ${PRIORITY_LABEL[item.priority] ?? item.priority}`);
      return lines.join('\n');
    })
    .join('\n\n');
  const text = [
    `Hi ${firstName},`,
    '',
    `You have ${count} action item${count === 1 ? '' : 's'} from the meeting "${title}"${when ? ` (${when})` : ''}:`,
    '',
    textItems,
    '',
    appUrl ? `Open Meeting to Action: ${appUrl}/` : null,
    '',
    'This message was sent because an administrator approved these tasks after reviewing the meeting.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  // ---------- HTML ----------
  const htmlItems = items
    .map((item) => {
      const due = formatDue(item.dueDate);
      return `
      <tr><td style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px;background:#ffffff">
        <div style="font-size:15px;font-weight:600;color:#0f172a">${escapeHtml(oneLine(item.title))}</div>
        ${item.description ? `<div style="margin-top:4px;font-size:14px;color:#475569;white-space:pre-wrap">${escapeHtml(item.description.trim())}</div>` : ''}
        <div style="margin-top:8px;font-size:13px;color:#64748b">
          Due: <strong style="color:#0f172a">${escapeHtml(due ?? 'No date set')}</strong>
          &nbsp;·&nbsp; Priority: <strong style="color:#0f172a">${escapeHtml(PRIORITY_LABEL[item.priority] ?? item.priority)}</strong>
        </div>
      </td></tr>
      <tr><td style="height:8px"></td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
        <tr><td style="padding-bottom:16px;font-size:13px;font-weight:600;color:#64748b">Meeting to Action</td></tr>
        <tr><td style="font-size:16px;color:#0f172a;padding-bottom:4px">Hi ${escapeHtml(firstName)},</td></tr>
        <tr><td style="font-size:14px;color:#334155;padding-bottom:16px">
          You have ${count} action item${count === 1 ? '' : 's'} from <strong>${escapeHtml(title)}</strong>${when ? ` <span style="color:#64748b">(${escapeHtml(when)})</span>` : ''}.
        </td></tr>
        ${htmlItems}
        ${appUrl ? `<tr><td style="padding-top:8px"><a href="${escapeHtml(appUrl)}/" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 16px;border-radius:6px">Open Meeting to Action</a></td></tr>` : ''}
        <tr><td style="padding-top:24px;font-size:12px;color:#94a3b8">This message was sent because an administrator approved these tasks after reviewing the meeting.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

export { escapeHtml };
