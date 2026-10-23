import { Router } from 'express';
import { z } from 'zod';
import * as tasksCtrl from '../controllers/tasksController.js';
import { validate } from '../middleware/validate.js';
import { TASK_STATUSES } from '../services/tasks.js';
import { idParams } from '../utils/validation.js';

// strict(): parameters like ?userId= are refused outright (ownership always comes from the session).
const listQuery = z.object({ status: z.enum(TASK_STATUSES).optional() }).strict();
// Only the status can be changed here; any other field is rejected by .strict().
const statusSchema = z.object({ status: z.enum(TASK_STATUSES), fromStatus: z.enum(TASK_STATUSES).optional() }).strict();

// Mounted at /me/tasks behind requireAuth (any role; always scoped to the signed-in user).
export const tasksRouter = Router();

tasksRouter.get('/', validate({ query: listQuery }), tasksCtrl.list);
tasksRouter.get('/:id', validate({ params: idParams }), tasksCtrl.get);
tasksRouter.patch('/:id/status', validate({ params: idParams, body: statusSchema }), tasksCtrl.updateStatus);
