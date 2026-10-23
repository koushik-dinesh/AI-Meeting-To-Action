// Canonical form for comparing person names and aliases: case-, diacritic- and
// punctuation-insensitive ("José  O'Neil" -> "jose o neil"). Shared with the Phase 3 assignee matcher.
export function normalizeName(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
