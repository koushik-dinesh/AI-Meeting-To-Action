import { useState } from 'react';
import { errorSummary, fieldErrorsFrom } from '../../utils/format.js';
import { Button, ErrorAlert, Field, inputClass } from '../ui.jsx';

const PRIORITIES = ['low', 'medium', 'high'];

// Shared by "Edit" on an item and "Add action item". Only sends fields that changed.
// Assignees can only be picked from active registered users (no free-text emails).
export function ActionItemForm({ item, users, submitLabel, onSubmit, onCancel, dueDateHint }) {
  const initial = {
    title: item?.title ?? '',
    description: item?.description ?? '',
    assigneeUserId: item?.assignee?.id ? String(item.assignee.id) : '',
    dueDate: item?.dueDate ?? '',
    priority: item?.priority ?? 'medium',
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // The current assignee may have been deactivated; keep it visible so it isn't silently dropped.
  const options = [...users];
  if (item?.assignee && !users.some((u) => u.id === item.assignee.id)) {
    options.push({ ...item.assignee, fullName: `${item.assignee.fullName} (inactive)`, disabled: true });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    if (!form.title.trim()) return setErrors({ title: 'Required' });

    const values = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      assigneeUserId: form.assigneeUserId ? Number(form.assigneeUserId) : null,
      dueDate: form.dueDate || null,
      priority: form.priority,
    };
    // For edits, send only what changed so untouched flags stay untouched.
    const body = item
      ? Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (k === 'assigneeUserId' ? item.assignee?.id ?? null : (item[k] ?? null))))
      : values;
    if (item && Object.keys(body).length === 0) return onCancel?.();

    setSaving(true);
    setErrors({});
    setError(null);
    try {
      await onSubmit(body);
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Field label="Title" error={errors.title}>
        <input className={inputClass} value={form.title} onChange={set('title')} maxLength={255} />
      </Field>
      <Field label="Description" error={errors.description}>
        <textarea className={`${inputClass} h-20`} value={form.description} onChange={set('description')} maxLength={5000} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Assignee" error={errors.assigneeUserId} hint="Registered users only">
          <select className={inputClass} value={form.assigneeUserId} onChange={set('assigneeUserId')}>
            <option value="">Unassigned</option>
            {options.map((u) => (
              <option key={u.id} value={u.id} disabled={u.disabled}>
                {u.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date" error={errors.dueDate} hint={dueDateHint}>
          <input className={inputClass} type="date" value={form.dueDate} onChange={set('dueDate')} />
        </Field>
        <Field label="Priority" error={errors.priority}>
          <select className={inputClass} value={form.priority} onChange={set('priority')}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorAlert error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
