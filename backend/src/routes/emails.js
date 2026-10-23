import { Router } from 'express';
import * as emailsCtrl from '../controllers/emailsController.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../utils/validation.js';

// Mounted at /emails behind requireAuth + requireRole('admin').
export const emailsRouter = Router();

emailsRouter.post('/:id/retry', validate({ params: idParams }), emailsCtrl.retry);
