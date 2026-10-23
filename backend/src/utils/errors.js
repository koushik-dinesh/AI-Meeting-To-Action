// Errors thrown on purpose. Anything else reaching the error handler is a 500.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
export const payloadTooLarge = (message) => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const tooManyRequests = (message = 'Too many requests, try again later') =>
  new AppError(429, 'RATE_LIMITED', message);
