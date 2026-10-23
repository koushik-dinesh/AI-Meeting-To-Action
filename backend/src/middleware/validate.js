import { badRequest } from '../utils/errors.js';

const formatIssues = (error) => error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));

// validate({ body, params, query }) — each a zod schema. Replaces req.body / req.params /
// req.query with the parsed, typed values.
export const validate = ({ body, params, query }) => (req, res, next) => {
  if (params) {
    const result = params.safeParse(req.params ?? {});
    if (!result.success) throw badRequest('Invalid URL parameters', formatIssues(result.error));
    req.params = result.data;
  }
  if (query) {
    const result = query.safeParse(req.query ?? {});
    if (!result.success) throw badRequest('Invalid query parameters', formatIssues(result.error));
    // req.query is a getter in Express 5; shadow it with the parsed value.
    Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
  }
  if (body) {
    const result = body.safeParse(req.body ?? {});
    if (!result.success) throw badRequest('Invalid request body', formatIssues(result.error));
    req.body = result.data;
  }
  next();
};
