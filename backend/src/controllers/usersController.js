import * as aliases from '../repositories/aliasesRepository.js';
import * as users from '../repositories/usersRepository.js';
import { audit } from '../services/audit.js';
import { normalizeName } from '../services/matching/normalize.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';

async function loadUser(id) {
  const row = await users.findAdminViewById(id);
  if (!row) throw notFound('User not found');
  return row;
}

export async function list(req, res) {
  const [rows, aliasRows] = await Promise.all([
    users.list({ includeInactive: req.query.includeInactive }),
    aliases.listAll(),
  ]);
  const byUser = Map.groupBy(aliasRows.map(aliases.toAlias), (a) => a.userId);
  res.json({ users: rows.map((r) => ({ ...users.toAdminUser(r), aliases: byUser.get(r.id) ?? [] })) });
}

// Creates the account without a password. It can be assigned tasks now; the invite flow that
// lets the person set a password is a later phase (PLANNING.md D5).
export async function create(req, res) {
  let id;
  try {
    id = await users.create({ ...req.body, passwordHash: null });
  } catch (err) {
    if (isDuplicate(err)) throw conflict('A user with this email already exists');
    throw err;
  }
  const user = users.toAdminUser(await loadUser(id));
  await audit({ actorUserId: req.user.id, action: 'user.created', entityType: 'user', entityId: id, after: user, ip: req.ip });
  res.status(201).json({ user: { ...user, aliases: [] } });
}

export async function update(req, res) {
  const { id } = req.params;
  const before = users.toAdminUser(await loadUser(id));

  // Prevent admins from locking themselves out.
  if (id === req.user.id) {
    if (req.body.role && req.body.role !== 'admin') throw badRequest('You cannot change your own role');
    if (req.body.isActive === false) throw badRequest('You cannot deactivate your own account');
  }

  try {
    await users.update(id, req.body);
  } catch (err) {
    if (isDuplicate(err)) throw conflict('A user with this email already exists');
    throw err;
  }
  const after = users.toAdminUser(await loadUser(id));
  await audit({ actorUserId: req.user.id, action: 'user.updated', entityType: 'user', entityId: id, before, after, ip: req.ip });
  res.json({ user: { ...after, aliases: (await aliases.listForUser(id)).map(aliases.toAlias) } });
}

// Soft delete: deactivated users keep their history but can't log in or be assigned.
export async function deactivate(req, res) {
  const { id } = req.params;
  if (id === req.user.id) throw badRequest('You cannot deactivate your own account');
  const before = users.toAdminUser(await loadUser(id));
  await users.update(id, { isActive: false });
  await audit({
    actorUserId: req.user.id,
    action: 'user.deactivated',
    entityType: 'user',
    entityId: id,
    before,
    after: { ...before, isActive: false },
    ip: req.ip,
  });
  res.status(204).end();
}

export async function listAliases(req, res) {
  await loadUser(req.params.id);
  res.json({ aliases: (await aliases.listForUser(req.params.id)).map(aliases.toAlias) });
}

export async function addAlias(req, res) {
  const { id } = req.params;
  await loadUser(id);
  const normalized = normalizeName(req.body.alias);
  if (!normalized) throw badRequest('Alias must contain letters or numbers');

  let aliasId;
  try {
    aliasId = await aliases.create(id, req.body.alias, normalized);
  } catch (err) {
    if (isDuplicate(err)) throw conflict('This user already has that alias');
    throw err;
  }
  const alias = aliases.toAlias(await aliases.findById(id, aliasId));
  // Shared aliases are allowed (two "Sam"s), but they will make matching ambiguous.
  const sharedWith = (await aliases.findOwnersOfNormalized(normalized, id)).map((u) => ({ id: u.id, fullName: u.full_name }));
  await audit({ actorUserId: req.user.id, action: 'user_alias.created', entityType: 'user', entityId: id, after: alias, ip: req.ip });
  res.status(201).json({ alias, sharedWith });
}

export async function removeAlias(req, res) {
  const { id, aliasId } = req.params;
  const existing = await aliases.findById(id, aliasId);
  if (!existing) throw notFound('Alias not found');
  await aliases.remove(id, aliasId);
  await audit({
    actorUserId: req.user.id,
    action: 'user_alias.deleted',
    entityType: 'user',
    entityId: id,
    before: aliases.toAlias(existing),
    ip: req.ip,
  });
  res.status(204).end();
}
