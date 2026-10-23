import { useEffect, useState } from 'react';
import { listUsers } from '../api/users.js';
import { ErrorAlert, inputClass } from './ui.jsx';

// Checkbox list of active users. `value` is an array of user ids.
export function ParticipantPicker({ value, onChange, disabled }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    listUsers({ includeInactive: false })
      .then((data) => setUsers(data.users))
      .catch(setError);
  }, []);

  if (error) return <ErrorAlert error={`Could not load users: ${error.message}`} />;
  if (!users) return <p className="text-sm text-slate-500">Loading users…</p>;
  if (users.length === 0) return <p className="text-sm text-slate-500">No active users yet. Add them on the Users page.</p>;

  const selected = new Set(value);
  const needle = filter.trim().toLowerCase();
  const visible = users.filter(
    (u) => !needle || u.fullName.toLowerCase().includes(needle) || u.email.includes(needle),
  );
  const toggle = (id) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Filter people…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`${inputClass} max-w-xs`}
          aria-label="Filter participants"
        />
        <span className="text-xs text-slate-500">{selected.size} selected</span>
      </div>
      <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
        {visible.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                onChange={() => toggle(u.id)}
                disabled={disabled}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="font-medium text-slate-900">{u.fullName}</span>
              <span className="truncate text-slate-500">{u.email}</span>
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No matches.</li>}
      </ul>
    </div>
  );
}
