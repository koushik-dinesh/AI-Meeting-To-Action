import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let admin; // cookie
let employee; // cookie
let adminId;

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin', fullName: 'Ada Admin' });
  await createUser({ email: 'emp@example.test', role: 'employee', fullName: 'Eve Employee' });
  admin = await loginCookie(app, 'admin@example.test');
  employee = await loginCookie(app, 'emp@example.test');
});
after(closeDatabase);

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
  delete: (url) => request(app).delete(url).set('Cookie', cookie),
});

describe('authorization', () => {
  it('rejects unauthenticated requests with 401', async () => {
    assert.equal((await request(app).get('/api/v1/users')).status, 401);
  });

  it('rejects employees with 403 on every users route', async () => {
    const e = as(employee);
    for (const res of [
      await e.get('/api/v1/users'),
      await e.post('/api/v1/users', { email: 'x@example.test', fullName: 'X' }),
      await e.patch(`/api/v1/users/${adminId}`, { fullName: 'Hacked' }),
      await e.delete(`/api/v1/users/${adminId}`),
      await e.post(`/api/v1/users/${adminId}/aliases`, { alias: 'Boss' }),
    ]) {
      assert.equal(res.status, 403);
    }
  });
});

describe('users CRUD', () => {
  let userId;

  it('creates a user without a password (cannot log in until invited)', async () => {
    const res = await as(admin).post('/api/v1/users', { email: ' New.Person@Example.test ', fullName: 'New Person' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'new.person@example.test');
    assert.equal(res.body.user.role, 'employee');
    assert.equal(res.body.user.hasPassword, false);
    userId = res.body.user.id;

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'new.person@example.test', password: 'anything-at-all' });
    assert.equal(login.status, 401);
  });

  it('validates input and rejects duplicate emails', async () => {
    const bad = await as(admin).post('/api/v1/users', { email: 'not-an-email', fullName: '', role: 'owner' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['email', 'fullName', 'role']);

    const dup = await as(admin).post('/api/v1/users', { email: 'emp@example.test', fullName: 'Dup' });
    assert.equal(dup.status, 409);
  });

  it('lists users with aliases and never exposes password hashes', async () => {
    const res = await as(admin).get('/api/v1/users');
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length >= 3);
    for (const u of res.body.users) {
      assert.equal(u.password_hash, undefined);
      assert.ok(Array.isArray(u.aliases));
    }
  });

  it('updates a user and rejects unknown fields', async () => {
    const res = await as(admin).patch(`/api/v1/users/${userId}`, { fullName: 'Renamed Person', role: 'admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, 'Renamed Person');
    assert.equal(res.body.user.role, 'admin');

    assert.equal((await as(admin).patch(`/api/v1/users/${userId}`, { passwordHash: 'x' })).status, 400);
    assert.equal((await as(admin).patch(`/api/v1/users/${userId}`, {})).status, 400);
    assert.equal((await as(admin).patch('/api/v1/users/999999', { fullName: 'Ghost' })).status, 404);
    assert.equal((await as(admin).patch('/api/v1/users/abc', { fullName: 'Ghost' })).status, 400);
  });

  it('prevents admins from demoting or deactivating themselves', async () => {
    assert.equal((await as(admin).patch(`/api/v1/users/${adminId}`, { role: 'employee' })).status, 400);
    assert.equal((await as(admin).patch(`/api/v1/users/${adminId}`, { isActive: false })).status, 400);
    assert.equal((await as(admin).delete(`/api/v1/users/${adminId}`)).status, 400);
  });

  it('deactivates (soft-deletes) a user and writes audit entries', async () => {
    assert.equal((await as(admin).delete(`/api/v1/users/${userId}`)).status, 204);
    const [[row]] = await pool.query('SELECT is_active FROM users WHERE id = ?', [userId]);
    assert.equal(row.is_active, 0);

    const [audit] = await pool.query(
      "SELECT action FROM audit_logs WHERE entity_type = 'user' AND entity_id = ? ORDER BY id",
      [userId],
    );
    assert.deepEqual(audit.map((a) => a.action), ['user.created', 'user.updated', 'user.deactivated']);
  });
});

describe('aliases', () => {
  let userId;
  let otherId;

  before(async () => {
    userId = await createUser({ email: 'jose@example.test', fullName: 'José Álvarez' });
    otherId = await createUser({ email: 'joe@example.test', fullName: 'Joe Other' });
  });

  it('adds, lists and removes aliases', async () => {
    const added = await as(admin).post(`/api/v1/users/${userId}/aliases`, { alias: '  Pepe ' });
    assert.equal(added.status, 201);
    assert.equal(added.body.alias.alias, 'Pepe');
    assert.deepEqual(added.body.sharedWith, []);

    const list = await as(admin).get(`/api/v1/users/${userId}/aliases`);
    assert.deepEqual(list.body.aliases.map((a) => a.alias), ['Pepe']);

    const removed = await as(admin).delete(`/api/v1/users/${userId}/aliases/${added.body.alias.id}`);
    assert.equal(removed.status, 204);
    assert.equal((await as(admin).get(`/api/v1/users/${userId}/aliases`)).body.aliases.length, 0);
  });

  it('rejects duplicates for the same user, case- and accent-insensitively', async () => {
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/aliases`, { alias: 'José' })).status, 201);
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/aliases`, { alias: 'jose' })).status, 409);
  });

  it('allows a shared alias but reports who else uses it', async () => {
    const res = await as(admin).post(`/api/v1/users/${otherId}/aliases`, { alias: 'JOSE' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.sharedWith.map((u) => u.id), [userId]);
  });

  it('validates aliases and 404s for unknown users or aliases', async () => {
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/aliases`, { alias: '' })).status, 400);
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/aliases`, { alias: '!!!' })).status, 400);
    assert.equal((await as(admin).post('/api/v1/users/999999/aliases', { alias: 'Ghost' })).status, 404);
    assert.equal((await as(admin).delete(`/api/v1/users/${userId}/aliases/999999`)).status, 404);
  });
});
