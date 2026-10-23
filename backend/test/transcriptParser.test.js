import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TranscriptParseError,
  detectFormat,
  formatTimestamp,
  parseTimestamp,
  parseTranscript,
  renderFullText,
} from '../src/services/transcripts/parser.js';

const rows = (content, opts) => parseTranscript(content, opts).segments.map((s) => [s.startSec, s.speaker, s.text]);

describe('parseTimestamp / formatTimestamp', () => {
  it('parses common forms', () => {
    assert.equal(parseTimestamp('00:12'), 12);
    assert.equal(parseTimestamp('1:02:03'), 3723);
    assert.equal(parseTimestamp('00:00:01,500'), 1.5);
    assert.equal(parseTimestamp('00:00:01.25'), 1.25);
    assert.equal(parseTimestamp('nope'), null);
    assert.equal(parseTimestamp('00:61'), null);
  });

  it('formats seconds', () => {
    assert.equal(formatTimestamp(65), '01:05');
    assert.equal(formatTimestamp(3723), '1:02:03');
    assert.equal(formatTimestamp(null), '');
  });
});

describe('plain text', () => {
  it('reads timestamps, speakers and continuation lines', () => {
    const text = [
      '[00:12] Jane Liu: Ship it Friday.',
      '00:45 Raj: Okay',
      'continued line',
      'Jane Liu (01:02:03): later',
      '[00:50] no speaker here',
      '',
      'Sam Lee  1:05',
      'header body line',
    ].join('\n');
    assert.deepEqual(rows(text), [
      [12, 'Jane Liu', 'Ship it Friday.'],
      [45, 'Raj', 'Okay continued line'],
      [3723, 'Jane Liu', 'later'],
      [50, null, 'no speaker here'],
      [65, 'Sam Lee', 'header body line'],
    ]);
  });

  it('keeps untimed, unlabeled text', () => {
    assert.deepEqual(rows('just some notes\nmore notes'), [[null, null, 'just some notes more notes']]);
  });

  it('does not treat long sentences ending in a colon as speakers', () => {
    assert.deepEqual(rows('We agreed on the following plan for the launch: ship Friday'), [
      [null, null, 'We agreed on the following plan for the launch: ship Friday'],
    ]);
  });
});

describe('WebVTT and SRT', () => {
  it('reads <v> voice tags, Name: prefixes, entities and skips NOTE blocks', () => {
    const vtt = 'WEBVTT\n\nNOTE exported\n\n1\n00:00:01.000 --> 00:00:04.500 align:start\n<v Jane Liu>Hello &amp; welcome</v>\n\n00:00:05.000 --> 00:00:06.000\nRaj: hi there\n';
    const { format, segments } = parseTranscript(vtt);
    assert.equal(format, 'vtt');
    assert.deepEqual(
      segments.map((s) => [s.startSec, s.endSec, s.speaker, s.text]),
      [
        [1, 4.5, 'Jane Liu', 'Hello & welcome'],
        [5, 6, 'Raj', 'hi there'],
      ],
    );
  });

  it('reads SRT with comma milliseconds', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nAlex: srt line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nno speaker\r\n';
    assert.equal(detectFormat(srt), 'srt');
    assert.deepEqual(rows(srt), [
      [1, 'Alex', 'srt line'],
      [3, null, 'no speaker'],
    ]);
  });
});

describe('Vexa JSON', () => {
  const json = JSON.stringify({
    segments: [
      { segment_id: 's1', speaker: 'Jane Liu', text: 'Hi', start: 12.4, end: 15.1, language: 'en', completed: true, confidence: 0.93 },
      { segment_id: 's2', speaker: '', text: 'unattributed', start: 16, end: 17, language: 'de', completed: true },
      { segment_id: 's3', speaker: 'Raj', text: 'draft', start: 18, completed: false },
    ],
  });

  it('keeps completed segments, ids, languages and confidence; empty speaker becomes null', () => {
    const { format, segments, raw } = parseTranscript(json);
    assert.equal(format, 'vexa_json');
    assert.ok(raw.segments);
    assert.deepEqual(
      segments.map((s) => [s.sourceId, s.speaker, s.startSec, s.endSec, s.language, s.confidence]),
      [
        ['s1', 'Jane Liu', 12.4, 15.1, 'en', 0.93],
        ['s2', null, 16, 17, 'de', null],
      ],
    );
  });

  it('rejects invalid JSON and wrong shapes', () => {
    assert.throws(() => parseTranscript('{bad', { format: 'vexa_json' }), TranscriptParseError);
    assert.throws(() => parseTranscript('{"foo":1}'), /segments/);
    assert.throws(() => parseTranscript('{"segments":[{"speaker":"x"}]}'), /text/);
  });
});

describe('general', () => {
  it('rejects empty transcripts', () => {
    assert.throws(() => parseTranscript('  \n \n'), /No transcript text/);
  });

  it('chooses the format from the file extension', () => {
    assert.equal(detectFormat('anything', 'call.VTT'), 'vtt');
    assert.equal(detectFormat('anything', 'call.json'), 'vexa_json');
    assert.equal(detectFormat('Jane: hi', 'notes.txt'), 'text');
  });

  it('makes segment ids unique', () => {
    const json = JSON.stringify([
      { segment_id: 'dup', text: 'a' },
      { segment_id: 'dup', text: 'b' },
    ]);
    const ids = parseTranscript(json).segments.map((s) => s.sourceId);
    assert.equal(new Set(ids).size, 2);
  });

  it('renders readable full text', () => {
    const { segments } = parseTranscript('[00:12] Jane: Hi\nno speaker');
    assert.equal(renderFullText(segments), '[00:12] Jane: Hi no speaker');
  });
});
