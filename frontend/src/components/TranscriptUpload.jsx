import { useState } from 'react';
import { uploadTranscript } from '../api/meetings.js';
import { Button, ErrorAlert, Field, inputClass } from './ui.jsx';

// Mirrors the backend limits (transcriptsController.js); the server enforces them regardless.
const MAX_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = ['.txt', '.vtt', '.srt', '.json'];

const FORMAT_OPTIONS = [
  ['auto', 'Detect automatically'],
  ['text', 'Plain text ([00:12] Name: text)'],
  ['vtt', 'WebVTT (.vtt)'],
  ['srt', 'SubRip (.srt)'],
  ['vexa_json', 'Vexa JSON'],
];

const PLACEHOLDER = `[00:00] Jane Liu: Thanks for joining, let's start with the launch.
[00:12] Raj Patel: I'll send the final deck by Friday.
[00:30] Jane Liu: Great. Sam, can you book the venue?`;

export function TranscriptUpload({ meetingId, hasTranscript, onUploaded }) {
  const [mode, setMode] = useState('paste');
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState('auto');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function pickFile(e) {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    if (f) {
      const ext = f.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
      if (!EXTENSIONS.includes(ext)) {
        setError(`Unsupported file type. Use ${EXTENSIONS.join(', ')}.`);
        e.target.value = '';
        return setFile(null);
      }
      if (f.size > MAX_BYTES) {
        setError('File is larger than 2 MB.');
        e.target.value = '';
        return setFile(null);
      }
    }
    setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);

    let content;
    let filename;
    if (mode === 'paste') {
      if (!text.trim()) return setError('Paste a transcript first.');
      content = text;
    } else {
      if (!file) return setError('Choose a file first.');
      content = await file.text(); // read as text only; never executed or rendered as HTML
      filename = file.name;
    }
    if (new Blob([content]).size > MAX_BYTES) return setError('Transcript is larger than 2 MB.');
    if (hasTranscript && !window.confirm('Replace the existing transcript? The current segments will be deleted.')) return;

    setBusy(true);
    try {
      const result = await uploadTranscript(meetingId, { content, format, ...(filename && { filename }) });
      setText('');
      setFile(null);
      onUploaded(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tab = (key, label) => (
    <button
      type="button"
      onClick={() => {
        setMode(key);
        setError(null);
      }}
      className={`rounded-md px-3 py-1.5 text-sm ${mode === key ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900'}`}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex gap-1">
        {tab('paste', 'Paste text')}
        {tab('file', 'Upload file')}
      </div>

      {mode === 'paste' ? (
        <Field label="Transcript" hint="One line per utterance. Timestamps and speaker names are optional but kept when present.">
          <textarea
            className={`${inputClass} h-48 font-mono`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
          />
        </Field>
      ) : (
        <Field label="Transcript file" hint=".txt, .vtt, .srt or Vexa .json — UTF-8 text, max 2 MB.">
          <input
            type="file"
            accept={EXTENSIONS.join(',')}
            onChange={pickFile}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:text-slate-700 hover:file:bg-slate-50"
          />
        </Field>
      )}

      <Field label="Format">
        <select className={`${inputClass} max-w-xs`} value={format} onChange={(e) => setFormat(e.target.value)}>
          {FORMAT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <ErrorAlert error={error} />
      <Button type="submit" disabled={busy}>
        {busy ? 'Uploading…' : hasTranscript ? 'Replace transcript' : 'Save transcript'}
      </Button>
    </form>
  );
}
