import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { requireAuth, requireRole } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { PASSWORD, closeDatabase, createUser, resetDatabase } from './helpers.js';

const app = createApp();
const ADMIN = 'admin@example.test';
const EMPLOYEE = 'employee@example.test';
const INACTIVE = 'inactive@example.test';

let employeeId;

before(async () => {
  await resetDatabase();
  await createUser({ email: ADMIN, role: 'admin' });
  employeeId = await createUser({ email: EMPLOYEE, role: 'employee' });
  await createUser({ email: INACTIVE, role: 'employee', isActive: false });
});
after(closeDatabase);

const login = (email, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ email, password });
const sessionCookie = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('mta_session='));

describe('POST /api/v1/auth/login', () => {
  it('rejects a missing or malformed body with 400', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.error.details));
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });

  it('returns the same 401 for a wrong password, unknown email, and inactive account', async () => {
    for (const res of [await login(ADMIN, 'wrong-password'), await login('nobody@example.test'), await login(INACTIVE)]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(sessionCookie(res), undefined);
    }
  });

  it('sets an httpOnly SameSite=Lax session cookie and returns the user without the hash', async () => {
    const res = await login(`  ${ADMIN.toUpperCase()} `); // email is trimmed and lower-cased
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, ADMIN);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.password_hash, undefined);
    assert.equal(res.body.user.passwordHash, undefined);

    const cookie = sessionCookie(res);
    assert.ok(cookie, 'session cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/i, 'not Secure outside production');
  });

  it('writes an audit log entry on success', async () => {
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.login'");
    assert.ok(rows[0].n >= 1);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: String(employeeId) }, 'x'.repeat(40));
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', `mta_session=${forged}`);
    assert.equal(res.status, 401);
  });

  it('returns the current user with a valid session', async () => {
    const cookie = sessionCookie(await login(EMPLOYEE));
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, EMPLOYEE);
    assert.equal(res.body.user.role, 'employee');
  });

  it('rejects an existing session once the user is deactivated', async () => {
    const id = await createUser({ email: 'soon-inactive@example.test' });
    const cookie = sessionCookie(await login('soon-inactive@example.test'));
    await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [id]);
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    assert.equal(res.status, 401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    assert.equal(res.status, 401);
  });

  it('clears the session cookie', async () => {
    const cookie = sessionCookie(await login(EMPLOYEE));
    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    assert.equal(res.status, 204);
    assert.match(sessionCookie(res), /Expires=Thu, 01 Jan 1970/);
  });
});

describe('requireRole', () => {
  // A throwaway app using the real middleware, since no admin-only API exists yet in Phase 1.
  const rbacApp = express();
  rbacApp.use(cookieParser());
  rbacApp.get('/admin-only', requireAuth, requireRole('admin'), (req, res) => res.json({ ok: true }));
  rbacApp.use(errorHandler);

  it('returns 401 when unauthenticated', async () => {
    const res = await request(rbacApp).get('/admin-only');
    assert.equal(res.status, 401);
  });

  it('returns 403 for an employee', async () => {
    const cookie = sessionCookie(await login(EMPLOYEE));
    const res = await request(rbacApp).get('/admin-only').set('Cookie', cookie);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('allows an admin', async () => {
    const cookie = sessionCookie(await login(ADMIN));
    const res = await request(rbacApp).get('/admin-only').set('Cookie', cookie);
    assert.equal(res.status, 200);
  });
});
