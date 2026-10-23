import { Router } from 'express';
import { pingDb } from '../db/pool.js';
import { logger } from '../utils/logger.js';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  let db = 'ok';
  try {
    await pingDb();
  } catch (err) {
    logger.warn('health: database unreachable', { error: err.message });
    db = 'unreachable';
  }
  const ok = db === 'ok';
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db });
});
