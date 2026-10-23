import { config } from '../config/index.js';
import { toPublicUser } from '../repositories/usersRepository.js';
import { audit } from '../services/audit.js';
import { sessionCookieOptions, signSession, verifyCredentials } from '../services/authService.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await verifyCredentials(email, password);
  if (!user) {
    logger.warn('login failed', { ip: req.ip });
    // Same message for unknown email, wrong password, and inactive account.
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const { token, expiresAt } = signSession(user.id);
  res.cookie(config.cookie.name, token, sessionCookieOptions(expiresAt));
  await audit({ actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip });
  res.json({ user: toPublicUser(user) });
}

export async function logout(req, res) {
  res.clearCookie(config.cookie.name, sessionCookieOptions());
  await audit({ actorUserId: req.user.id, action: 'auth.logout', entityType: 'user', entityId: req.user.id, ip: req.ip });
  res.status(204).end();
}

export function me(req, res) {
  res.json({ user: req.user });
}
