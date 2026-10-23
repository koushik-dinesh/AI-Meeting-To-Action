// Parses manually supplied transcripts into segments. Pure functions: input is text,
// output is data. Nothing here touches the filesystem or evaluates content.
//
// Supported formats
//   text       one utterance per line, optional timestamp and speaker:
//                [00:12] Jane Liu: Let's ship Friday.     00:12 Jane: ...     Jane: ...
//                Jane Liu (01:02:03): ...                 [00:12] text without speaker
//              a line with only "Jane Liu:" or "Jane Liu 00:12" starts a block; following
//              plain lines belong to it. Other plain lines continue the previous segment.
//   vtt        WebVTT; speakers from <v Name> voice tags or a "Name: " prefix (Teams, Zoom, Meet exports)
//   srt        SubRip; speakers from a "Name: " prefix
//   vexa_json  Vexa's documented transcript shape: { "segments": [ { speaker, text, start, end,
//              language, completed, confidence, segment_id } ] } (or a bare array of those)

export const FORMATS = ['text', 'vtt', 'srt', 'vexa_json'];
export const MAX_SEGMENTS = 20_000;
const MAX_SEGMENT_TEXT = 60_000; // TEXT column holds 64 KB
const MAX_SPEAKER = 200;
const MAX_SECONDS = 9_999_999; // DECIMAL(10,2)

export class TranscriptParseError extends Error {}

const TS = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)`;
// A speaker label: starts with a letter, up to 60 chars of name-like characters.
const NAME = String.raw`([\p{L}][\p{L}\p{M}\p{N}'’.\- ]{0,59}?)`;

const RE_LEADING_TS = new RegExp(String.raw`^[\[(]?${TS}[\])]?\s*(?:[-–—|]\s*)?(.*)$`, 'u');
const RE_SPEAKER_TS_COLON = new RegExp(String.raw`^${NAME}\s*[\[(]${TS}[\])]\s*:?\s*(.*)$`, 'u');
const RE_SPEAKER_TS_HEADER = new RegExp(String.raw`^${NAME}\s+${TS}$`, 'u');
const RE_SPEAKER_COLON = new RegExp(String.raw`^${NAME}\s*:(?:\s+(.*))?$`, 'u');

/** "01:02:03.5" | "02:03" | "00:00:01,000" -> seconds (number) or null */
export function parseTimestamp(value) {
  if (!value) return null;
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!m) return null;
  const [, h = '0', min, s, frac = '0'] = m;
  if (Number(min) > 59 && h !== '0') return null;
  if (Number(s) > 59) return null;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(`0.${frac}`);
}

export function formatTimestamp(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const total = Math.floor(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const looksLikeName = (name) => name.trim().split(/\s+/).length <= 5;

function cleanSpeaker(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_SPEAKER) : null;
}

function finiteSeconds(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SECONDS ? Math.round(n * 100) / 100 : null;
}

// ---------- plain text ----------

function parseTextLine(line) {
  let m = RE_SPEAKER_TS_HEADER.exec(line);
  if (m && looksLikeName(m[1])) return { speaker: m[1], ts: m[2], text: '', header: true };

  m = RE_SPEAKER_TS_COLON.exec(line);
  if (m && looksLikeName(m[1])) return { speaker: m[1], ts: m[2], text: m[3], header: !m[3] };

  let ts = null;
  let rest = line;
  m = RE_LEADING_TS.exec(line);
  if (m) {
    ts = m[1];
    rest = m[2];
  }

  m = RE_SPEAKER_COLON.exec(rest);
  if (m && looksLikeName(m[1])) return { speaker: m[1], ts, text: m[2] ?? '', header: !m[2] };

  return { speaker: null, ts, text: rest, header: false };
}

function parseText(content) {
  const segments = [];
  let current = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseTextLine(line);

    if (parsed.speaker || parsed.ts || parsed.header) {
      current = { speaker: parsed.speaker, startSec: parseTimestamp(parsed.ts), text: parsed.text.trim() };
      segments.push(current);
    } else if (current) {
      current.text = current.text ? `${current.text} ${parsed.text}` : parsed.text;
    } else {
      current = { speaker: null, startSec: null, text: parsed.text };
      segments.push(current);
    }
  }
  return segments;
}

// ---------- WebVTT / SRT ----------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '', '&rlm;': '', '&quot;': '"', '&#39;': "'" };
const decodeEntities = (s) => s.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm|quot|#39);/g, (e) => ENTITIES[e]);

function parseCues(content) {
  const segments = [];
  const blocks = content.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue; // WEBVTT header, NOTE, STYLE, REGION, stray text

    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex]);
    if (!timing) continue;

    const raw = lines.slice(timingIndex + 1).filter(Boolean).join(' ');
    if (!raw) continue;

    let speaker = null;
    const voice = /<v(?:\.[^\s>]+)*\s+([^>]+)>/.exec(raw);
    if (voice) speaker = voice[1];
    let text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

    if (!speaker) {
      const m = RE_SPEAKER_COLON.exec(text);
      if (m && m[2] && looksLikeName(m[1])) {
        speaker = m[1];
        text = m[2].trim();
      }
    }
    if (!text) continue;

    segments.push({
      speaker,
      startSec: parseTimestamp(timing[1]),
      endSec: parseTimestamp(timing[2]),
      text,
    });
  }
  return segments;
}

// ---------- Vexa JSON ----------

function parseVexaJson(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new TranscriptParseError('The file is not valid JSON');
  }
  const list = Array.isArray(data) ? data : data?.segments;
  if (!Array.isArray(list)) throw new TranscriptParseError('JSON must be an array of segments or an object with a "segments" array');

  const segments = [];
  list.forEach((seg, i) => {
    if (!seg || typeof seg !== 'object' || typeof seg.text !== 'string') {
      throw new TranscriptParseError(`Segment ${i} must be an object with a "text" string`);
    }
    if (seg.completed === false) return; // live drafts are superseded by completed segments
    const confidence = typeof seg.confidence === 'number' && seg.confidence >= 0 && seg.confidence <= 1 ? seg.confidence : null;
    segments.push({
      sourceId: typeof seg.segment_id === 'string' && seg.segment_id ? seg.segment_id : null,
      speaker: seg.speaker,
      startSec: seg.start,
      endSec: seg.end,
      language: typeof seg.language === 'string' && /^[A-Za-z-]{2,10}$/.test(seg.language) ? seg.language : null,
      confidence,
      text: seg.text,
    });
  });
  return { segments, raw: data };
}

// ---------- entry point ----------

export function detectFormat(content, filename) {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'vtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  if (ext === 'json') return 'vexa_json';

  const start = content.replace(/^﻿/, '').trimStart();
  if (start.startsWith('WEBVTT')) return 'vtt';
  if (start.startsWith('{') || start.startsWith('[{')) return 'vexa_json';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(start)) return 'srt';
  return 'text';
}

/**
 * @returns {{ format, segments: Array<{sourceId, speaker, text, startSec, endSec, language, confidence}>, raw? }}
 */
export function parseTranscript(content, { format = 'auto', filename } = {}) {
  const resolved = format === 'auto' ? detectFormat(content, filename) : format;
  if (!FORMATS.includes(resolved)) throw new TranscriptParseError(`Unsupported format "${resolved}"`);

  let segments;
  let raw;
  if (resolved === 'vexa_json') ({ segments, raw } = parseVexaJson(content));
  else if (resolved === 'text') segments = parseText(content);
  else segments = parseCues(content);

  const seenIds = new Set();
  const normalized = [];
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT_TEXT);
    if (!text) continue;
    const index = normalized.length;
    let sourceId = (seg.sourceId ?? `${resolved}:${index}`).slice(0, 120);
    if (seenIds.has(sourceId)) sourceId = `${sourceId}#${index}`;
    seenIds.add(sourceId);
    normalized.push({
      sourceId,
      speaker: cleanSpeaker(seg.speaker),
      text,
      startSec: finiteSeconds(seg.startSec),
      endSec: finiteSeconds(seg.endSec),
      language: seg.language ?? null,
      confidence: seg.confidence ?? null,
    });
  }

  if (normalized.length === 0) throw new TranscriptParseError('No transcript text found');
  if (normalized.length > MAX_SEGMENTS) {
    throw new TranscriptParseError(`Transcript has ${normalized.length} segments; the limit is ${MAX_SEGMENTS}`);
  }
  return { format: resolved, segments: normalized, raw };
}

/** "[00:12] Jane Liu: text" lines, the readable form stored in transcripts.full_text. */
export function renderFullText(segments) {
  return segments
    .map((s) => {
      const ts = s.startSec === null ? '' : `[${formatTimestamp(s.startSec)}] `;
      const who = s.speaker ? `${s.speaker}: ` : '';
      return `${ts}${who}${s.text}`;
    })
    .join('\n');
}
