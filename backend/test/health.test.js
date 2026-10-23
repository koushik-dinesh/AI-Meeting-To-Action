import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase } from './helpers.js';

const app = createApp();
after(closeDatabase);

describe('GET /api/v1/health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', db: 'ok' });
  });

  it('sets basic security headers and hides Express', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});

describe('unknown routes', () => {
  it('return a structured 404', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
