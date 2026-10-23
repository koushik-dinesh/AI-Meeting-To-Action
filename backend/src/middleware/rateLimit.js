import { tooManyRequests } from '../utils/errors.js';

// In-memory fixed-window limiter. Fine for a single API process; move to MySQL
// or Redis if the API is ever scaled horizontally.
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw tooManyRequests();
    }
    next();
  };
}
