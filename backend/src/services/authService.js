import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import * as users from '../repositories/usersRepository.js';

export const BCRYPT_ROUNDS = 12;

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_ROUNDS);

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/** Returns the user row if the credentials are valid and the account is active, else null. */
export async function verifyCredentials(email, password) {
  const user = await users.findByEmailWithHash(email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.password_hash || !user.is_active) return null;
  return user;
}

export function signSession(userId) {
  const token = jwt.sign({ sub: String(userId) }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn,
  });
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Returns the user id from a valid token, or null. */
export function verifySession(token) {
  try {
    const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    const id = Number(payload.sub);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: 'lax',
    path: '/',
    ...(expiresAt && { expires: expiresAt }),
  };
}
