import { config } from '../config/index.js';
import * as users from '../repositories/usersRepository.js';
import { verifySession } from '../services/authService.js';
import { forbidden, unauthorized } from '../utils/errors.js';

// Requires a valid session cookie. Re-reads the user every request so that
// deactivation and role changes take effect immediately.
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookie.name];
  const userId = token && verifySession(token);
  if (!userId) throw unauthorized();

  const row = await users.findById(userId);
  if (!row || !row.is_active) throw unauthorized();

  req.user = users.toPublicUser(row);
  next();
}

// Use after requireAuth.
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) throw unauthorized();
  if (!roles.includes(req.user.role)) throw forbidden();
  next();
};
