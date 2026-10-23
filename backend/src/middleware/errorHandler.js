import { AppError, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res, next) {
  next(notFound(`Route ${req.method} ${req.path} not found`));
}

// Response shape for every error: { error: { code, message, details? } }
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code, path: req.path });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
    });
  }

  // Malformed JSON body from express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }

  logger.error('unhandled error', { method: req.method, path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
