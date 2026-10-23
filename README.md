# AI Meeting to Action

Turns meeting transcripts into reviewed, assigned action items. Design, decisions and roadmap: [docs/PLANNING.md](docs/PLANNING.md).

**Status: Phase 7 (Vexa meeting bot).** Login and roles, users/aliases, meetings, manual and bot transcripts (Vexa), background AI extraction, admin review, email notifications, and the employee task portal.

## Stack

- **backend/**: Node 22, Express 5, mysql2 (no ORM, plain SQL migrations), JWT in an httpOnly cookie, bcrypt, zod validation
- **frontend/**: React 19, Vite 8, React Router 8, Tailwind CSS 4 (configured via `@tailwindcss/vite`, so there is no `tailwind.config.js`)
- **docker-compose.yml**: MySQL 8.4 (host port 3307) and Mailpit (UI 8025, SMTP 1025)
- Vexa is **not** part of this repo. It runs from its own checkout and compose project (see PLANNING.md §7).

## Prerequisites

- Node.js 22 (`nvm use` reads `.nvmrc`)
- Docker Desktop, OrbStack or Colima, for MySQL and Mailpit

## First-time setup

```bash
nvm use
cp .env.example .env                    # set MYSQL_ROOT_PASSWORD and MYSQL_PASSWORD
cp backend/.env.example backend/.env    # DB_PASSWORD must equal MYSQL_PASSWORD; set JWT_SECRET and SEED_ADMIN_PASSWORD
docker compose up -d                    # MySQL 8.4 on 127.0.0.1:3307, Mailpit on :8025 / :1025
```

Generate a JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The compose init script also creates the `meeting_action_test` database used by the tests. It only runs on the **first** start of an empty volume. If you change `.env` afterwards, recreate the volume with `docker compose down -v` (this deletes all local data).

Then install, migrate and seed:

```bash
cd backend && npm install && npm run migrate && npm run seed
cd ../frontend && npm install
```

`npm run seed` creates the admin from `SEED_ADMIN_*` and, if `SEED_EMPLOYEE_*` is set, an employee. Passwords must be at least 12 characters. The seed refuses to run with `NODE_ENV=production` and skips users that already exist.

## Running

```bash
cd backend && npm run dev      # API on http://localhost:4000
cd frontend && npm run dev     # app on http://localhost:5173 (proxies /api to :4000)
```

Open http://localhost:5173 and sign in with the seeded credentials. Admins land on `/admin`, employees on `/my/tasks`.

### AI extraction (Phase 3)

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, default `claude-opus-5-5`, and `MEETING_TIMEZONE`) in `backend/.env`, run `npm run migrate`, restart the API, and start the worker in another terminal:

```bash
cd backend && npm run worker      # or npm run worker:dev to restart on file changes
```

The worker checks the configured model with the Models API on startup. Then, for a meeting that has a transcript:

```bash
curl -b cookies.txt -X POST http://localhost:4000/api/v1/meetings/<id>/extract       # 202, job queued
curl -b cookies.txt http://localhost:4000/api/v1/meetings/<id>/action-items          # items, evidence, flags, run status
```

(Log in first with `curl -c cookies.txt -H 'Content-Type: application/json' -d '{"email":"…","password":"…"}' http://localhost:4000/api/v1/auth/login`.)
The meeting moves `transcript_ready → extracting → review_pending` (or `failed`, with `last_error`). Every saved item has transcript evidence that was verified against the stored segments; ownership and deadline problems are listed in `flags` (descriptions in the `flagDescriptions` field). Re-running extraction replaces the meeting's pending AI items and never touches items already approved or rejected. The rules are documented at the top of `backend/src/services/ai/validator.js`.

### Email notifications (Phase 5)

After a review is finished (meeting status `approved`), the meeting page shows an **Email notifications** panel: a preview of who gets which approved items, an explicit Send (with confirmation), per-recipient status, and Retry for failed emails. Nothing is ever sent automatically.

For local testing, emails go to Mailpit (already in `docker-compose.yml`). Add to `backend/.env`, then restart the API and the worker:

```
EMAIL_PROVIDER=smtp
EMAIL_FROM="Meeting to Action <no-reply@example.test>"
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
APP_PUBLIC_URL=http://localhost:5173
```

Open http://localhost:8025 to see the messages. For production, use real SMTP credentials (`SMTP_USER`/`SMTP_PASS`, `SMTP_SECURE=true` for port 465) or `EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and a verified sending domain in `EMAIL_FROM`.

How delivery works: each recipient gets one email per meeting containing only their approved items, addressed to their registered email. The request creates `email_messages` rows (unique `idempotency_key` per meeting + recipient + item set, so repeated clicks never duplicate) and one `email.send` job each. Temporary failures retry with exponential backoff up to `EMAIL_MAX_ATTEMPTS`; permanent ones (rejected address, auth) fail immediately and can be retried from the UI. Sent emails are never resent. If a worker dies mid-send, that message is marked failed with an explanation rather than risking a duplicate. "Sent" means the mail server or Resend accepted the message; it does not prove inbox delivery.

### Employee task portal (Phase 6)

Employees sign in and land on **My tasks** (`/my/tasks`): summary counts (total, not started, in progress, completed, overdue), filters (status, priority, overdue, search) and sorting, and a detail page per task with meeting context, the supporting transcript excerpt, and history. They can move their own tasks between Not started, In progress, Blocked and Completed (including reopening).

Rules (enforced by the API, `GET /api/v1/me/tasks`, `GET /api/v1/me/tasks/:id`, `PATCH /api/v1/me/tasks/:id/status`):
- Only tasks assigned to the signed-in user, approved, from a meeting whose review is finished. Anything else, including other people's tasks, is a 404.
- Only `status` can be changed (title, priority, due date, assignee and review status are admin-only). Every change and its audit entry are written in one transaction; a `fromStatus` check rejects stale double submissions.
- Overdue = due date before today in `MEETING_TIMEZONE`, and not completed.
- Status changes don't send email; the admin sees progress in the meeting's action items.

### Meeting bot via Vexa (Phase 7)

Vexa runs **outside this repo** as its own Docker Compose project; this app only calls its REST API from the backend. Services for the full flow:

| Service | Where | Port |
|---|---|---|
| Frontend (Vite) | `frontend/` | 5173 |
| API + worker | `backend/` (`npm run dev`, `npm run worker`) | 4000 |
| MySQL + Mailpit | this repo's `docker-compose.yml` | 3307, 8025/1025 |
| Vexa gateway | separate checkout, e.g. `~/vexa` (`make all && make bot`) | 18056 |
| Transcription (faster-whisper) | Vexa's `deploy/transcription` | 8083 |

Add to `backend/.env` (then restart the API and the worker):

```
VEXA_BASE_URL=http://localhost:18056
VEXA_API_KEY=<key printed by Vexa's make all; needs the bot and tx scopes>
```

Optional: `VEXA_BOT_NAME`, `VEXA_POLL_INTERVAL_MS` (15 s), `VEXA_POLL_TIMEOUT_MS` (4 h), `VEXA_TRANSCRIPT_WAIT_MS` (5 min), `VEXA_AUTO_EXTRACT` (true).

On a meeting with a Google Meet link (`https://meet.google.com/abc-defg-hij`), the **Meeting bot** panel sends the bot, shows its state (joining, waiting in the lobby — admit it in Meet — in the meeting, ended, failed with the reason), and can stop it. The worker polls Vexa (`vexa.poll` job), imports the transcript when the meeting ends (speakers, timestamps, languages kept; drafts dropped) and, if AI is configured and `VEXA_AUTO_EXTRACT=true`, queues extraction. Review, approval and email stay manual. An existing transcript (e.g. uploaded by hand) is never overwritten automatically; "Replace with Vexa transcript" does it explicitly. Manual upload keeps working for any meeting.

The integration was built against Vexa's gateway OpenAPI contract (api.v1) and tested with a mocked Vexa; it has not yet been run against a real Vexa instance and Google Meet (PLANNING.md Phase 0 spike).

## Tests

```bash
cd backend && NODE_ENV=test npm run migrate   # optional; the tests migrate automatically
cd backend && npm test
```

The tests run against `DB_TEST_NAME` and **delete all data in that database** (meetings, jobs, audit logs, users). They never touch `DB_NAME`. Claude is always mocked: under `NODE_ENV=test` the API key is ignored, so the suite never makes paid API calls.

## API (Phase 1)

All routes are under `/api/v1`. Errors always look like `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public. Returns 503 if the DB is unreachable |
| POST | `/auth/login` | public. Body `{ email, password }`, sets the `mta_session` cookie. Limited to 10 attempts per IP+email per 15 min |
| POST | `/auth/logout` | logged in. Clears the cookie |
| GET | `/auth/me` | logged in |

Middleware for later phases: `requireAuth`, `requireRole('admin')`, `validate({ body: zodSchema })`.

## Security notes

- The session cookie is `HttpOnly` and `SameSite=Lax`. It is `Secure` when `NODE_ENV=production`, or when you force it with `COOKIE_SECURE=true`.
- `JWT_SECRET` must be at least 32 characters. The API won't start in production with the example value.
- Every request re-reads the user from the database, so deactivation and role changes take effect immediately.
- Logout clears the cookie, but the JWT is stateless: a copied token stays valid until it expires (`JWT_EXPIRES_IN`, default 8h). Add a denylist or session table if this matters.
- The frontend route guards are for UX only. The API enforces authentication and roles.
- Never commit `.env` files. `.gitignore` excludes everything except `*.env.example`.

## Layout

```
backend/src/
  app.js, server.js       Express wiring and startup
  config/                 env loading and validation (zod)
  db/                     pool.js, migrate.js, migrations/*.sql, seeds/
  middleware/             auth (requireAuth, requireRole), validate, rateLimit, errorHandler
  routes/ controllers/    HTTP layer
  services/ repositories/ business logic and SQL
  utils/                  logger (JSON lines), errors
backend/test/             node:test + supertest integration tests
frontend/src/
  api/ auth/ components/ pages/{admin,employee}/ router.jsx
```
