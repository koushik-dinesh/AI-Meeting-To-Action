export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO string -> value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO string (UTC), or null when empty. */
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

export function formatTimestamp(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Banner text for a failed save: field-level problems are shown next to the fields instead. */
export const errorSummary = (err) =>
  err?.code === 'VALIDATION_ERROR' && err.details?.some((d) => d.field) ? 'Please fix the highlighted fields.' : err;

/** Server validation details -> { field: message } */
export const fieldErrorsFrom = (err) =>
  Object.fromEntries((err?.details ?? []).map((d) => [d.field || '_', d.message]));

/** 'YYYY-MM-DD' -> "Fri, 6 Nov 2026" without timezone shifting. */
export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
