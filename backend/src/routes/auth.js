import { Router } from 'express';
import { z } from 'zod';
import * as auth from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  password: z.string().min(1).max(200),
});

// 10 attempts per IP+email per 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
});

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), auth.login);
authRouter.post('/logout', requireAuth, auth.logout);
authRouter.get('/me', requireAuth, auth.me);
