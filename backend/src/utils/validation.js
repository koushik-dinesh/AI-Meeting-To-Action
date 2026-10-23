import { z } from 'zod';

export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const idParams = z.object({ id });

export const email = z.string().trim().toLowerCase().pipe(z.email().max(255));
export const personName = z.string().trim().min(1, 'Required').max(200);
export const role = z.enum(['admin', 'employee']);

// Empty string from a form clears an optional value.
export const optionalNullable = (schema) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());

export const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
