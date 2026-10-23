// Maps a spoken name to a registered user (PLANNING.md §1 "Assignee matching").
//
//   exact full name or alias, one user      -> assign  (match 'exact' / 'alias', confidence high)
//   unique first-name match                  -> assign  (match 'fuzzy', confidence medium, flagged)
//   several users match at the same level    -> do not assign, 'ambiguous_assignee'
//   nobody matches                           -> do not assign, 'unknown_assignee'
//   the only match is inactive               -> do not assign, 'inactive_assignee'
//
// Emails are never inferred: the result is a user id from the directory or nothing.
import { normalizeName } from './normalize.js';

/**
 * Builds a reusable directory index from users and aliases.
 * @param users   [{ id, fullName, isActive }]
 * @param aliases [{ userId, alias }]
 */
export function buildDirectory(users, aliases) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const fullName = new Map(); // normalized full name -> Set(userId)
  const alias = new Map(); // normalized alias -> Set(userId)
  const firstName = new Map(); // normalized first token -> Set(userId)
  const add = (map, key, id) => key && (map.get(key) ?? map.set(key, new Set()).get(key)).add(id);

  for (const u of users) {
    const norm = normalizeName(u.fullName);
    add(fullName, norm, u.id);
    add(firstName, norm.split(' ')[0], u.id);
  }
  for (const a of aliases) if (byId.has(a.userId)) add(alias, normalizeName(a.alias), a.userId);
  return { byId, fullName, alias, firstName };
}

const candidatesOf = (dir, ids) => [...ids].map((id) => dir.byId.get(id)).map((u) => ({ id: u.id, fullName: u.fullName, isActive: u.isActive }));

/**
 * @returns {{ userId: number|null, match: 'exact'|'alias'|'fuzzy'|'none', confidence: 'high'|'medium'|null,
 *             flags: string[], candidates: {id, fullName, isActive}[], reason: string }}
 */
export function matchAssignee(nameRaw, dir) {
  const none = (flag, reason, candidates = []) => ({ userId: null, match: 'none', confidence: null, flags: [flag], candidates, reason });
  if (!nameRaw || !nameRaw.trim()) return none('missing_assignee', 'No owner was named');

  const norm = normalizeName(nameRaw);
  if (!norm) return none('unknown_assignee', `"${nameRaw}" is not a usable name`);
  if (norm.includes('@')) return none('unknown_assignee', 'Email addresses are not accepted as assignees');

  // matchFor(id) names how the single remaining candidate was found.
  const decide = (ids, matchFor, confidence, extraFlags = []) => {
    const candidates = candidatesOf(dir, ids);
    if (candidates.length > 1) {
      return none('ambiguous_assignee', `"${nameRaw}" matches ${candidates.length} users`, candidates);
    }
    const [user] = candidates;
    if (!user.isActive) return none('inactive_assignee', `${user.fullName} is inactive`, candidates);
    const match = matchFor(user.id);
    return { userId: user.id, match, confidence, flags: extraFlags, candidates, reason: `Matched ${user.fullName} by ${match === 'fuzzy' ? 'first name' : match}` };
  };

  // Level 1: exact full name or alias. Both count as one level so "Sam" (alias of A) vs
  // "Sam" (full name of B) is ambiguous rather than silently preferring one.
  const exactIds = new Set(dir.fullName.get(norm) ?? []);
  const aliasIds = new Set(dir.alias.get(norm) ?? []);
  const level1 = new Set([...exactIds, ...aliasIds]);
  if (level1.size > 0) return decide(level1, (id) => (exactIds.has(id) ? 'exact' : 'alias'), 'high');

  // Level 2: a single-word name matching exactly one user's first name.
  if (!norm.includes(' ')) {
    const firstIds = dir.firstName.get(norm);
    if (firstIds?.size) return decide(firstIds, () => 'fuzzy', 'medium', ['assignee_first_name_only']);
  }

  return none('unknown_assignee', `No registered user named "${nameRaw}"`);
}
