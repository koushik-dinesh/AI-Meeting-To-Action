import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { actionItemsRouter } from './actionItems.js';
import { authRouter } from './auth.js';
import { emailsRouter } from './emails.js';
import { healthRouter } from './health.js';
import { meetingsRouter } from './meetings.js';
import { tasksRouter } from './tasks.js';
import { usersRouter } from './users.js';

// Mounted at /api/v1. Admin-only routers sit behind requireAuth + requireRole('admin').
export const apiRouter = Router();

const adminOnly = [requireAuth, requireRole('admin')];

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', ...adminOnly, usersRouter);
apiRouter.use('/meetings', ...adminOnly, meetingsRouter);
apiRouter.use('/action-items', ...adminOnly, actionItemsRouter);
apiRouter.use('/emails', ...adminOnly, emailsRouter);
// The signed-in user's own tasks (employee portal). Not admin-only, but always scoped to req.user.
apiRouter.use('/me/tasks', requireAuth, tasksRouter);
