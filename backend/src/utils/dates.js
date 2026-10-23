// Calendar-date helpers. Dates are 'YYYY-MM-DD' strings in the meeting's timezone; arithmetic
// is done in UTC on those plain dates, so DST changes can't shift a day.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromIso = (iso) => new Date(`${iso}T00:00:00Z`);

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toIso(fromIso(value)) === value;
}

export const addDays = (iso, days) => {
  const d = fromIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
};

export const daysBetween = (fromIsoDate, toIsoDate) => Math.round((fromIso(toIsoDate) - fromIso(fromIsoDate)) / 86_400_000);
export const weekdayOf = (iso) => fromIso(iso).getUTCDay();
export const weekdayName = (iso) => WEEKDAYS[weekdayOf(iso)].replace(/^./, (c) => c.toUpperCase());

/** The calendar date of an instant in a timezone, e.g. (2026-11-02T23:30Z, 'Asia/Tokyo') -> '2026-11-03'. */
export function localDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const lastDayOfMonth = (iso) => {
  const d = fromIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

function monthIndex(word) {
  const w = word.toLowerCase();
  return MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
}

function weekdayIndex(word) {
  const w = word.toLowerCase();
  const full = WEEKDAYS.indexOf(w);
  return full !== -1 ? full : (WEEKDAY_ALIASES[w] ?? -1);
}

// Matched after filler words ("of", "the", …) are stripped, so "end of the quarter" is "end quarter".
const VAGUE = /\b(soon|asap|as soon as possible|later|sometime|some time|eventually|next week|next month|this month|this week|this quarter|next quarter|q[1-4]|end (quarter|year)|mid|early|beginning)\b/;

/**
 * Deterministically resolves an English deadline expression relative to the meeting date.
 *
 *   { date: 'YYYY-MM-DD' }        resolved
 *   { ambiguous: true }           recognised but could mean more than one date (or is vague)
 *   { recognized: false }         not an expression this parser understands
 *
 * `refDate` may be null (meeting date unknown): then only absolute dates with a year resolve.
 * Policy (deliberately conservative): "next <weekday>" is ambiguous; a bare weekday equal
 * to the meeting's weekday is ambiguous; numeric dates like 11/12 are ambiguous (locale).
 */
export function resolveDeadline(raw, refDate) {
  if (!raw) return { recognized: false };
  const text = raw
    .toLowerCase()
    .replace(/[.,!?;]+/g, ' ')
    .replace(/\b(by|before|on|until|till|due|no later than|at the latest|latest|the|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const res = (date) => (date ? { recognized: true, date } : { recognized: true, ambiguous: true });

  // ISO date: unambiguous with or without a meeting date.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return isValidIsoDate(text) ? res(text) : { recognized: false };

  // Month name + day (+ year): "november 20", "nov 20th 2026", "20 november", "20th november 2026"
  m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(text) ?? null;
  let month, day, year;
  if (m && monthIndex(m[1]) !== -1) [month, day, year] = [monthIndex(m[1]), Number(m[2]), m[3]];
  else {
    m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(text);
    if (m && monthIndex(m[2]) !== -1) [month, day, year] = [monthIndex(m[2]), Number(m[1]), m[3]];
  }
  if (month !== undefined) {
    if (year) {
      const iso = `${year}-${pad(month + 1)}-${pad(day)}`;
      return isValidIsoDate(iso) ? res(iso) : { recognized: false };
    }
    if (!refDate) return res(null);
    const refYear = Number(refDate.slice(0, 4));
    let iso = `${refYear}-${pad(month + 1)}-${pad(day)}`;
    if (!isValidIsoDate(iso)) return { recognized: false };
    const diff = daysBetween(refDate, iso);
    if (diff < 0) {
      // Clearly next year only if the date is far behind the meeting; otherwise unclear.
      if (diff < -180) iso = `${refYear + 1}-${pad(month + 1)}-${pad(day)}`;
      else return res(null);
    }
    return res(iso);
  }

  if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(text)) return res(null); // 11/12: locale-dependent

  if (!refDate) {
    // Everything below is relative to the meeting date.
    return /^(today|tonight|tomorrow|eod|end day|in .+|this .+|next .+|end .+|[a-z]+day)$/.test(text) || VAGUE.test(text)
      ? res(null)
      : { recognized: false };
  }

  if (/^(today|tonight|eod|end day|end business day|cob|close business)$/.test(text)) return res(refDate);
  if (text === 'tomorrow' || text === 'tomorrow morning' || text === 'end day tomorrow') return res(addDays(refDate, 1));

  m = /^in (\d+|[a-z]+) (day|days|week|weeks)$/.exec(text);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (!n || n > 365) return { recognized: false };
    return res(addDays(refDate, m[2].startsWith('week') ? n * 7 : n));
  }

  if (/^(end month|month end|eom)$/.test(text)) return res(lastDayOfMonth(refDate));
  if (/^(end week|eow|week end)$/.test(text)) {
    const wd = weekdayOf(refDate);
    return wd >= 1 && wd <= 4 ? res(addDays(refDate, 5 - wd)) : res(null); // Friday of this week
  }

  m = /^(this |next |coming |this coming )?([a-z]+)$/.exec(text);
  if (m && weekdayIndex(m[2]) !== -1) {
    if (m[1]?.trim() === 'next') return res(null); // "next Friday": this coming one or the one after?
    const target = weekdayIndex(m[2]);
    const diff = (target - weekdayOf(refDate) + 7) % 7;
    return diff === 0 ? res(null) : res(addDays(refDate, diff));
  }

  if (VAGUE.test(text)) return res(null);
  return { recognized: false };
}
