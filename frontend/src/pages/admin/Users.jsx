import { useCallback, useEffect, useState } from 'react';
import { addAlias, createUser, deactivateUser, listUsers, removeAlias, updateUser } from '../../api/users.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { errorSummary, fieldErrorsFrom } from '../../utils/format.js';

export function UsersPage() {
  const [users, setUsers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState('');

  const reload = useCallback(
    () =>
      listUsers()
        .then((data) => {
          setUsers(data.users);
          setLoadError(null);
        })
        .catch(setLoadError),
    [],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  const replaceUser = (updated) => setUsers((list) => list.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="mt-1 text-sm text-slate-500">
          People who can be meeting participants and task assignees. Aliases help match the names used in transcripts.
        </p>
      </div>

      <CreateUserForm
        onCreated={(user) => {
          setUsers((list) => [...(list ?? []), user]);
          setNotice(`${user.fullName} added. They can't sign in until the invitation flow is built (later phase).`);
        }}
      />
      <SuccessAlert>{notice}</SuccessAlert>

      {loadError && <ErrorAlert error={`Could not load users: ${loadError.message}`} />}
      {!users && !loadError && <Loading />}
      {users?.length === 0 && <EmptyState title="No users">Add the first person above.</EmptyState>}
      {users?.length > 0 && (
        <div className="space-y-3">
          {users.map((u) => (
            <UserRow key={u.id} user={u} onChange={replaceUser} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateUserForm({ onCreated }) {
  const empty = { fullName: '', email: '', role: 'employee' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    const clientErrors = {};
    if (!form.fullName.trim()) clientErrors.fullName = 'Required';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) clientErrors.email = 'Enter a valid email';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    setError(null);
    try {
      const { user } = await createUser({ ...form, fullName: form.fullName.trim(), email: form.email.trim() });
      onCreated(user);
      setForm(empty);
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Add user">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <ErrorAlert error={error} />
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-start">
          <Field label="Full name" error={errors.fullName}>
            <input className={inputClass} value={form.fullName} onChange={set('fullName')} maxLength={200} />
          </Field>
          <Field label="Email" error={errors.email}>
            <input className={inputClass} type="email" value={form.email} onChange={set('email')} maxLength={255} />
          </Field>
          <Field label="Role" error={errors.role}>
            <select className={inputClass} value={form.role} onChange={set('role')}>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Button type="submit" disabled={saving} className="sm:mt-6">
            {saving ? 'Adding…' : 'Add user'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UserRow({ user, onChange }) {
  const { user: me } = useAuth();
  const isSelf = me.id === user.id;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setForm({ fullName: user.fullName, email: user.email, role: user.role });
    setErrors({});
    setError(null);
    setEditing(true);
  }

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
    } finally {
      setBusy(false);
    }
  }

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const { user: updated } = await updateUser(user.id, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        ...(isSelf ? {} : { role: form.role }),
      });
      onChange(updated);
      setEditing(false);
    });
  };

  const toggleActive = () =>
    run(async () => {
      if (user.isActive) {
        if (!window.confirm(`Deactivate ${user.fullName}? They will no longer be able to sign in or be assigned tasks.`)) return;
        await deactivateUser(user.id);
        onChange({ ...user, isActive: false });
      } else {
        const { user: updated } = await updateUser(user.id, { isActive: true });
        onChange(updated);
      }
    });

  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 ${user.isActive ? '' : 'opacity-70'}`}>
      {editing ? (
        <form onSubmit={save} noValidate className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Full name" error={errors.fullName}>
              <input className={inputClass} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </Field>
            <Field label="Email" error={errors.email}>
              <input className={inputClass} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Role" error={errors.role} hint={isSelf ? 'You cannot change your own role.' : undefined}>
              <select className={inputClass} value={form.role} disabled={isSelf} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="employee">Employee</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          </div>
          <ErrorAlert error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium text-slate-900">
              {user.fullName}
              {isSelf && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
            </p>
            <p className="text-sm text-slate-500">{user.email}</p>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize text-slate-700">{user.role}</span>
              {!user.isActive && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">inactive</span>}
              {user.isActive && !user.hasPassword && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">no password yet</span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={startEdit} disabled={busy}>
              Edit
            </Button>
            {!isSelf && (
              <Button variant={user.isActive ? 'danger' : 'secondary'} onClick={toggleActive} disabled={busy}>
                {user.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </div>
          {!editing && error && <ErrorAlert error={error} className="w-full" />}
        </div>
      )}
      <AliasEditor user={user} onChange={(aliases) => onChange({ ...user, aliases })} />
    </div>
  );
}

function AliasEditor({ user, onChange }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!value.trim()) return setError('Enter an alias');
    setBusy(true);
    setError(null);
    setWarning('');
    try {
      const { alias, sharedWith } = await addAlias(user.id, value.trim());
      onChange([...user.aliases, alias].sort((a, b) => a.alias.localeCompare(b.alias)));
      setValue('');
      if (sharedWith.length) {
        setWarning(`Also used by ${sharedWith.map((u) => u.fullName).join(', ')}; matches on this name will need review.`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(alias) {
    setBusy(true);
    setError(null);
    try {
      await removeAlias(user.id, alias.id);
      onChange(user.aliases.filter((a) => a.id !== alias.id));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Aliases</span>
        {user.aliases.length === 0 && <span className="text-xs text-slate-400">none</span>}
        {user.aliases.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs text-slate-700">
            {a.alias}
            <button
              type="button"
              onClick={() => remove(a)}
              disabled={busy}
              aria-label={`Remove alias ${a.alias}`}
              className="rounded-full px-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={add} className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Add alias, e.g. Jim"
            maxLength={200}
            aria-label={`New alias for ${user.fullName}`}
            className="w-40 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
          />
          <Button type="submit" variant="secondary" disabled={busy} className="!px-2 !py-1 text-xs">
            Add
          </Button>
        </form>
      </div>
      {warning && <p className="mt-2 text-xs text-amber-700">{warning}</p>}
      <ErrorAlert error={error} className="mt-2" />
    </div>
  );
}
