import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDirectory, matchAssignee } from '../src/services/matching/assigneeMatcher.js';

const users = [
  { id: 1, fullName: 'Jane Liu', isActive: true },
  { id: 2, fullName: 'Raj Patel', isActive: true },
  { id: 3, fullName: 'Sam Lee', isActive: true },
  { id: 4, fullName: 'Sam Carter', isActive: true },
  { id: 5, fullName: 'Ana García', isActive: true },
  { id: 6, fullName: 'Jonas Weber', isActive: false },
  { id: 7, fullName: 'Priya Shah', isActive: true },
  { id: 8, fullName: 'Alex Kim', isActive: true },
  { id: 9, fullName: 'Alex Kim', isActive: true },
];
const aliases = [
  { userId: 1, alias: 'JL' },
  { userId: 2, alias: 'Rajesh' },
  { userId: 3, alias: 'Sammy' },
  { userId: 4, alias: 'Sammy' },
];
const dir = buildDirectory(users, aliases);

describe('matchAssignee', () => {
  it('exact full-name match is a high-confidence assignment', () => {
    const m = matchAssignee('Raj Patel', dir);
    assert.deepEqual([m.userId, m.match, m.confidence, m.flags], [2, 'exact', 'high', []]);
  });

  it('alias match assigns the alias owner', () => {
    const m = matchAssignee('Rajesh', dir);
    assert.deepEqual([m.userId, m.match, m.confidence], [2, 'alias', 'high']);
    assert.equal(matchAssignee('jl', dir).userId, 1);
  });

  it('unique first-name match is medium confidence and flagged', () => {
    const m = matchAssignee('Priya', dir);
    assert.deepEqual([m.userId, m.match, m.confidence, m.flags], [7, 'fuzzy', 'medium', ['assignee_first_name_only']]);
  });

  it('does not assign when several users share a first name', () => {
    const m = matchAssignee('Sam', dir);
    assert.equal(m.userId, null);
    assert.deepEqual(m.flags, ['ambiguous_assignee']);
    assert.deepEqual(m.candidates.map((c) => c.id).sort(), [3, 4]);
  });

  it('does not assign duplicate full names or shared aliases', () => {
    assert.deepEqual(matchAssignee('Alex Kim', dir).flags, ['ambiguous_assignee']);
    assert.deepEqual(matchAssignee('Sammy', dir).flags, ['ambiguous_assignee']);
  });

  it('leaves unknown names unassigned', () => {
    const m = matchAssignee('Zed Nobody', dir);
    assert.deepEqual([m.userId, m.match, m.flags], [null, 'none', ['unknown_assignee']]);
    assert.deepEqual(matchAssignee(null, dir).flags, ['missing_assignee']);
    assert.deepEqual(matchAssignee('jane@example.test', dir).flags, ['unknown_assignee']);
  });

  it('never assigns an inactive user', () => {
    const m = matchAssignee('Jonas Weber', dir);
    assert.deepEqual([m.userId, m.flags], [null, ['inactive_assignee']]);
    assert.equal(matchAssignee('Jonas', dir).userId, null);
  });

  it('is case-, accent- and punctuation-insensitive', () => {
    assert.equal(matchAssignee('ANA GARCIA', dir).userId, 5);
    assert.equal(matchAssignee('ana  garcía', dir).userId, 5);
    assert.equal(matchAssignee('jane-liu', dir).userId, 1);
  });
});
