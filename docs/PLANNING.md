# AI Meeting to Action — Planning & Analysis

Status: **draft, decisions in §6.2 resolved**. Nothing implemented yet.
Vexa facts below were read from the Vexa README and docs.vexa.ai (v0.12 line) on 2026-10-23. Items marked *(unverified)* still need confirming against a running instance.

---

## 0. Verified Vexa facts that shape the design

| Topic | What the docs say | Design consequence |
|---|---|---|
| Deployment | `make all` = Docker Compose stack (gateway `:18056`, meeting-api, admin-api, runtime, redis, **postgres**, S3-compatible storage). `make bot` must be run to build a compatible bot image. Binds to 127.0.0.1. | Vexa runs as its **own compose project** with its own Postgres. Our app never touches its DB — REST only. |
| Auth | `X-API-Key` header on every call. `make all` prints a key. | Key lives only in backend `.env`. |
| Start bot | `POST /bots` with `meeting_url` (API derives platform / id / passcode) or `platform` + `native_meeting_id`; optional `language`, `bot_name`, `recording_enabled`, `transcribe_enabled`. 201 / 409 already active / 422 bad URL / 429 concurrency / **503 no STT configured**. | We store `platform` + `native_meeting_id` returned by Vexa. 409 is treated as "already running", not failure. |
| Status / stop | `GET /bots/status`, `DELETE /bots/{platform}/{native_meeting_id}`, `GET /meetings/{id}` | Poller tracks lifecycle. |
| Transcript | `GET /transcripts/{platform}/{native_meeting_id}` → `segments[]` with `speaker`, `text`, `start`, `end`, `absolute_start_time`, `language`, `completed`, `confidence`. | Only `completed: true` segments are persisted. `speaker` **may be empty** (~4–7% under crosstalk). |
| Webhooks | `PUT /user/webhook` with `webhook_url`, `webhook_secret`, events `meeting.completed`, `meeting.status_change`, `meeting.started`, `bot.failed`. HMAC-SHA256 over `"<timestamp>." + body` in `X-Webhook-Signature`. Exact JSON payload *(unverified)*. Delivery-history endpoint is buggy (#841). | **Polling is the primary mechanism**; webhook is an optional accelerator that only *triggers* a poll (so we never depend on its payload shape). |
| WebSocket | README says "planned (poll today)". | Not used. |
| Platforms | Google Meet (prod), Zoom (web client), Teams (prod), Jitsi (unvalidated). | Start with **Google Meet**; others are config, not code. |
| Language | Omit `language` → per-window auto-detect, stamped per segment. | Multilingual works out of the box; Claude receives the language tag. |
| Transcription | Separate unit: faster-whisper behind an OpenAI-compatible `/v1/audio/transcriptions`. GPU compose or `docker-compose.cpu.yml`. Configured via `TRANSCRIPTION_SERVICE_URL` / `_TOKEN` / `_MODEL`. | Self-hosted CPU on Mac is possible but slow; see risks. |
| Apple Silicon | arm64 images "best-effort / experimental"; **`vexaai/vexa-bot` is amd64-only** (runs under emulation on M-series). | Biggest local-dev risk; see §6. |
| Bot behaviour | Leaves after ~10 min alone; may sit in lobby until admitted. | UI must show "waiting in lobby" and the admin must admit the bot. |
| License | Apache-2.0. | OK. |

---

## 1. System architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                Our application               │
 Browser                 │                                              │
┌──────────────┐  HTTPS  │  ┌─────────────────────┐   ┌───────────────┐ │
│ React + Vite │────────▶│  │ Express API (REST)  │──▶│    MySQL 8    │ │
│ Tailwind     │  cookie │  │ auth, RBAC, routes  │   │ app data +    │ │
│ admin / emp. │◀────────│  └─────────┬───────────┘   │ jobs table    │ │
└──────────────┘  JSON   │            │ enqueue       └───────▲───────┘ │
                         │  ┌─────────▼───────────┐           │         │
                         │  │ Worker (same code,  │───────────┘         │
                         │  │ separate process)   │ claims jobs         │
                         │  │  • vexa.poll        │                     │
                         │  │  • transcript.fetch │──────────┐          │
                         │  │  • ai.extract       │───┐      │          │
                         │  │  • email.send       │─┐ │      │          │
                         │  └─────────────────────┘ │ │      │          │
                         └──────────────────────────┼─┼──────┼──────────┘
                                                    │ │      │ X-API-Key
                                   SMTP / Resend ◀──┘ │      ▼
                                   Anthropic API ◀────┘  ┌────────────────────────┐
                                                         │ Vexa (separate compose)│
                                                         │ gateway :18056         │
                                                         │ meeting-api, runtime → │
                                                         │ bot containers ─▶ Meet │
                                                         │ postgres, redis, S3    │
                                                         └──────────┬─────────────┘
                                                                    ▼
                                                         ┌────────────────────────┐
                                                         │ Transcription unit     │
                                                         │ faster-whisper (CPU or │
                                                         │ GPU host), OpenAI-compat│
                                                         └────────────────────────┘
```

**Key choices**

- **Two Node processes, one codebase**: `api` (HTTP) and `worker` (job loop). No Redis/BullMQ — a MySQL `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED` gives retries, backoff, and idempotency with zero extra infrastructure. Swappable later for BullMQ behind the same `enqueue()` interface.
- **Vexa adapter** (`services/vexa/`) is the only code that knows Vexa URLs. Everything else sees `startBot(meetingUrl)`, `getBotStatus()`, `getTranscript()`.
- **Email provider adapter** (`services/email/`) with `smtp` and `resend` implementations chosen by env var.
- **AI extraction** uses Claude with a strict JSON schema (tool/structured output), then a **deterministic validator** in our code: assignee matching, date parsing, duplicate detection, confidence flags. Claude never sees or produces email addresses — it outputs names; *our* code maps names → registered users.
- **State machines** (stored as ENUM columns) for meetings, action items, and email messages; every transition writes an `audit_logs` row.

**Meeting lifecycle**

```
draft → bot_requested → bot_joining → in_progress → ended → transcript_ready
      → extracting → review_pending → approved → emails_sent
(any) → failed   (with error + retry button)
```

**Action item lifecycle**

```
extracted (flags?) → [admin edits] → approved | rejected
approved → emailed → (employee) todo → in_progress → done | blocked
```

**Email duplicate prevention**: one `email_messages` row per (meeting, recipient) with a unique `idempotency_key = sha256(meeting_id:user_id:sorted item ids)`. The worker sends only rows in `queued`/`retry` state, marks `sending` inside a transaction, and records the provider message id. Resend supports an `Idempotency-Key` header; for SMTP we rely on the DB lock + state.

**Assignee matching (never invent emails)**

1. Claude returns `assignee_name` as spoken + `assignee_confidence`.
2. Backend matches against `users.full_name`, `user_aliases.alias` (nicknames, transcript speaker labels), case/diacritic-insensitive; exact → high, unique first-name → medium, multiple/none → **unassigned + flag**.
3. Admin resolves flags in review UI; resolutions can optionally be saved as aliases.

---

## 2. Folder structure

```
ai-meeting-to-action-prototype/
├── docs/                      PLANNING.md, ADRs, Vexa notes
├── docker-compose.yml         mysql (+ mailpit for dev email)
├── .env.example               root-level only lists compose vars
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── src/
│   │   ├── server.js          starts Express
│   │   ├── worker.js          starts job loop
│   │   ├── app.js             express app wiring
│   │   ├── config/            env loading + validation
│   │   ├── db/
│   │   │   ├── pool.js        mysql2 pool
│   │   │   ├── migrations/    001_init.sql, ...
│   │   │   ├── seeds/         dev users
│   │   │   └── migrate.js     tiny runner (no ORM)
│   │   ├── middleware/        auth, requireRole, validate, errorHandler, rateLimit
│   │   ├── routes/            auth, users, meetings, actionItems, tasks, emails, audit, webhooks
│   │   ├── controllers/
│   │   ├── services/
│   │   │   ├── vexa/          client.js, mapper.js
│   │   │   ├── ai/            claudeClient.js, extractionPrompt.js, schema.js, validator.js
│   │   │   ├── email/         index.js, smtpProvider.js, resendProvider.js, templates/
│   │   │   ├── matching/      assigneeMatcher.js
│   │   │   └── audit.js
│   │   ├── jobs/
│   │   │   ├── queue.js       enqueue / claim / complete / fail(backoff)
│   │   │   └── handlers/      vexaPoll.js, transcriptFetch.js, aiExtract.js, emailSend.js
│   │   ├── repositories/      SQL per table
│   │   └── utils/             errors, logger, dates
│   └── test/                  unit (validator, matcher, queue) + fixtures (sample transcripts)
└── frontend/
    ├── package.json
    ├── vite.config.js         proxy /api → backend
    ├── tailwind.config.js
    └── src/
        ├── main.jsx, App.jsx, router.jsx
        ├── api/               fetch wrapper + endpoint fns
        ├── auth/              AuthContext, ProtectedRoute
        ├── components/        Table, StatusBadge, Modal, FlagChip ...
        └── pages/
            ├── admin/         Dashboard, Meetings, MeetingDetail, ReviewActionItems,
            │                  Users, Emails, AuditLog
            └── employee/      MyTasks, TaskDetail
```

Vexa is **not** in this repo; it's cloned separately (e.g. `~/vexa`) and run with its own `make all`.

---

## 3. MySQL database design (MySQL 8+, InnoDB, utf8mb4)

```sql
users (
  id BIGINT PK AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  password_hash VARCHAR(255) NULL,          -- null until invite accepted
  role ENUM('admin','employee') NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at, updated_at
)

user_aliases (                               -- names/speaker labels used in meetings
  id PK, user_id FK→users, alias VARCHAR(200), normalized_alias VARCHAR(200),
  UNIQUE(normalized_alias, user_id), INDEX(normalized_alias)
)

meetings (
  id PK, title VARCHAR(255), meeting_url VARCHAR(1024) NOT NULL,
  platform VARCHAR(32) NULL, native_meeting_id VARCHAR(255) NULL,
  vexa_meeting_id VARCHAR(64) NULL,
  scheduled_at DATETIME NULL, started_at, ended_at,
  status ENUM('draft','bot_requested','bot_joining','in_progress','ended',
              'transcript_ready','extracting','review_pending','approved',
              'emails_sent','failed') NOT NULL,
  language_hint VARCHAR(10) NULL,
  last_error TEXT NULL,
  created_by FK→users, created_at, updated_at,
  INDEX(status), UNIQUE(platform, native_meeting_id, scheduled_at)
)

meeting_participants (meeting_id FK, user_id FK, PRIMARY KEY(meeting_id,user_id))
                                             -- optional: narrows assignee matching

transcripts (
  id PK, meeting_id FK UNIQUE,
  full_text MEDIUMTEXT,                      -- "[00:12] Jane: ..." rendered form
  raw_json JSON,                             -- Vexa response as received
  detected_languages JSON, segment_count INT,
  fetched_at DATETIME
)

transcript_segments (
  id PK, transcript_id FK, vexa_segment_id VARCHAR(128),
  speaker VARCHAR(200) NULL, text TEXT, start_sec DECIMAL(10,2), end_sec DECIMAL(10,2),
  language VARCHAR(10) NULL, confidence DECIMAL(4,3) NULL,
  UNIQUE(transcript_id, vexa_segment_id)
)

extraction_runs (                            -- every Claude call, for debugging/cost
  id PK, meeting_id FK, model VARCHAR(64), prompt_version VARCHAR(16),
  status ENUM('running','succeeded','failed'),
  input_tokens INT, output_tokens INT, raw_response JSON, error TEXT,
  created_at
)

action_items (
  id PK, meeting_id FK, extraction_run_id FK NULL,
  title VARCHAR(255), description TEXT,
  assignee_name_raw VARCHAR(200) NULL,       -- what Claude heard
  assignee_user_id FK→users NULL,            -- what WE matched / admin chose
  assignee_match ENUM('exact','alias','fuzzy','manual','none'),
  due_date DATE NULL, due_date_raw VARCHAR(200) NULL,   -- "next Friday"
  priority ENUM('low','medium','high') DEFAULT 'medium',
  review_status ENUM('pending','approved','rejected') DEFAULT 'pending',
  task_status ENUM('todo','in_progress','blocked','done') DEFAULT 'todo',
  flags JSON,                                -- ["ambiguous_assignee","ambiguous_deadline","low_confidence"]
  ai_confidence DECIMAL(4,3) NULL,
  approved_by FK NULL, approved_at, created_at, updated_at,
  INDEX(meeting_id, review_status), INDEX(assignee_user_id, task_status)
)

action_item_evidence (                       -- supporting transcript excerpts
  id PK, action_item_id FK, excerpt TEXT, speaker VARCHAR(200),
  start_sec DECIMAL(10,2) NULL, segment_id FK→transcript_segments NULL
)

email_messages (
  id PK, meeting_id FK, recipient_user_id FK, recipient_email VARCHAR(255),  -- snapshot
  subject VARCHAR(255), html_body MEDIUMTEXT, text_body MEDIUMTEXT,
  idempotency_key CHAR(64) UNIQUE NOT NULL,
  status ENUM('queued','sending','sent','failed','retry') NOT NULL,
  provider VARCHAR(20), provider_message_id VARCHAR(255) NULL,
  attempt_count INT DEFAULT 0, last_error TEXT, next_attempt_at DATETIME,
  sent_at DATETIME NULL, created_at, updated_at
)

email_message_items (email_message_id FK, action_item_id FK, PRIMARY KEY(both))

email_attempts (                             -- one row per provider call
  id PK, email_message_id FK, attempted_at, success BOOLEAN,
  error TEXT, provider_response JSON
)

jobs (
  id PK, type VARCHAR(64), payload JSON,
  dedupe_key VARCHAR(191) NULL UNIQUE,       -- e.g. "ai.extract:meeting:42"
  status ENUM('pending','running','succeeded','failed','dead'),
  attempts INT DEFAULT 0, max_attempts INT DEFAULT 5,
  run_at DATETIME, locked_at DATETIME NULL, locked_by VARCHAR(64) NULL,
  last_error TEXT, created_at, updated_at,
  INDEX(status, run_at)
)

audit_logs (
  id PK, actor_user_id FK NULL,              -- null = system/worker
  action VARCHAR(64),                        -- "meeting.created","item.approved","email.sent"
  entity_type VARCHAR(32), entity_id BIGINT,
  before_json JSON NULL, after_json JSON NULL,
  ip VARCHAR(45) NULL, created_at,
  INDEX(entity_type, entity_id), INDEX(created_at)
)

refresh_tokens / password_reset_tokens       -- only if decision D5 needs them
```

Migrations: plain `.sql` files + ~40-line runner storing applied filenames in `schema_migrations`. No ORM.

---

## 4. API endpoints (`/api/v1`, JSON, httpOnly-cookie JWT)

**Auth**
| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/logout` | any |
| GET | `/auth/me` | any |
| POST | `/auth/accept-invite` (set password from token) | public + token |

**Users** (admin)
| GET | `/users` · POST `/users` (invite) · PATCH `/users/:id` · DELETE `/users/:id` (deactivate) |
| GET/POST/DELETE | `/users/:id/aliases` |

**Meetings** (admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/meetings` | filters: status, date |
| POST | `/meetings` | title, meeting_url, scheduled_at?, language?, participant ids? |
| GET | `/meetings/:id` | incl. status, counts |
| PATCH | `/meetings/:id` | |
| POST | `/meetings/:id/bot` | request Vexa bot |
| DELETE | `/meetings/:id/bot` | stop bot |
| POST | `/meetings/:id/transcript/refresh` | re-fetch from Vexa |
| POST | `/meetings/:id/transcript/upload` | manual transcript fallback (dev/testing without Vexa) |
| GET | `/meetings/:id/transcript` | segments |
| POST | `/meetings/:id/extract` | (re)run Claude; replaces *pending* items only |
| GET | `/meetings/:id/action-items` | |
| POST | `/meetings/:id/approve` | approve all pending, blocks if unresolved flags |
| POST | `/meetings/:id/send-emails` | groups approved items by recipient, enqueues |

**Action items**
| PATCH | `/action-items/:id` (admin: edit fields, assignee, due date, resolve flags) |
| POST | `/action-items/:id/approve` · `/action-items/:id/reject` (admin) |
| POST | `/meetings/:id/action-items` (admin: add manually) |

**Employee tasks**
| GET | `/me/tasks` (filters: status) |
| GET | `/me/tasks/:id` |
| PATCH | `/me/tasks/:id/status` (todo/in_progress/blocked/done, own tasks only) |

**Tracking** (admin)
| GET | `/dashboard/summary` |
| GET | `/emails` · GET `/emails/:id` · POST `/emails/:id/retry` |
| GET | `/audit-logs` (filters: entity, actor, date) |
| GET | `/jobs` (failed/dead jobs) · POST `/jobs/:id/retry` |

**Integrations**
| POST | `/webhooks/vexa` — HMAC-verified; only enqueues `vexa.poll` for the meeting |
| GET | `/health` |

---

## 5. Implementation phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Infra & spike** | Install Docker; run Vexa `make all` + `make bot` + transcription unit; send a bot to a test Google Meet manually with curl; capture a real transcript JSON as a fixture. | Real transcript JSON saved in `backend/test/fixtures/`. Confirms Vexa works on chosen host. |
| **1. Skeleton** | Repo layout, MySQL compose, migrations, Express app, error handling, logger, auth (login/me/logout), RBAC middleware, seed admin, React shell with login + role routing. | Admin and employee can log in and see role-specific empty pages. |
| **2. Meetings + manual transcript** | Users/aliases CRUD, meetings CRUD, transcript upload endpoint, segments stored, transcript viewer. | Can create a meeting and attach a transcript without Vexa. |
| **3. AI extraction + validation** | Job queue + worker, Claude client with JSON schema, prompt v1, validator, assignee matcher, flags, extraction_runs logging. Unit tests on fixtures. | Uploaded transcript → flagged action items in DB. |
| **4. Review UI** | Review page: evidence excerpts, edit, reassign, resolve flags, approve/reject, add manual items. | Admin can get a meeting to `approved`. |
| **5. Email** | Provider adapter, HTML template, grouping, idempotency, retries w/ backoff, email_attempts, Mailpit locally. | Approved items → one email per recipient; re-click doesn't duplicate. |
| **6. Employee portal** | My tasks list/detail, status updates, audit entries. | Employee updates status; admin sees it. |
| **7. Vexa integration** | Vexa adapter, request/stop bot, status poller, auto transcript fetch → auto extract, optional webhook. | URL in → review queue out, no manual steps. |
| **8. Tracking & hardening** | Dashboard, email/job/audit views, rate limiting, input validation everywhere, README. | Prototype demo-ready. |

Phases 2–6 deliberately don't depend on Vexa, so Vexa setup problems can't block the core product.

---

## 6. Technical risks & unresolved decisions

### 6.1 Risks

1. **Vexa on Apple Silicon** — bot image is amd64-only; emulation via Rosetta/QEMU runs headless Chromium slowly and may drop audio. Mitigation: Phase 0 spike; fallback is a small Linux x86 VM.
2. **CPU transcription speed** — faster-whisper on CPU (especially inside an arm64 Docker VM) may not keep up with live audio for medium/large models. Mitigation: `small`/`base` model locally, or a GPU host / free-tier API (decision D2).
3. **Bot admission** — Meet/Teams put bots in the lobby; organization policies may block anonymous joins entirely.
4. **Speaker attribution gaps** — empty `speaker` on some segments; names in transcript may not match user records. Mitigation: aliases + flags + admin review.
5. **Vexa API churn** — v0.12, several endpoints documented as 404/planned, webhook payload unverified. Mitigation: single adapter, polling-first, contract test against fixture.
6. **LLM hallucination** — invented tasks or deadlines. Mitigation: require evidence excerpts, verify excerpts actually appear in transcript, human approval gate.
7. **Relative dates** ("next Friday") — need meeting date + timezone as reference. Mitigation: pass meeting date/timezone to Claude, store `due_date_raw`, flag anything not parseable.
8. **Long transcripts** — 1–2 h meetings fit in Claude's context window, but cost scales. Mitigation: log tokens per run; chunking only if needed.
9. **Email deliverability** — free tiers require a verified domain (Resend) or have daily limits / app-password requirements (Gmail SMTP).
10. **Privacy / consent** — recording participants may require notice/consent depending on jurisdiction; transcripts are sensitive data at rest.
11. **Local toolchain** — Docker is not installed; Node is v18 (EOL). Need Node 22 LTS.

### 6.2 Decisions needed from you

| # | Decision | Options | My default |
|---|---|---|---|
| D1 | Where Vexa runs | (a) on this Mac via Docker Desktop (experimental arm64, emulated bot) (b) Linux x86 VM/cloud box (c) start with manual transcript upload, Vexa later | (a) for the spike, fall back to (b) |
| D2 | Transcription | (a) self-hosted faster-whisper CPU (b) self-hosted on a GPU machine you have (c) free-tier hosted Whisper API (e.g. Groq) for dev only | (a) with small model |
| D3 | Platforms for v1 | Google Meet only / + Teams / + Zoom | Google Meet only |
| D4 | Email provider | Resend free tier (needs a domain you own) / SMTP (Gmail app password or similar) / dev-only Mailpit | Mailpit for dev, provider chosen in Phase 5 |
| D5 | Employee access | (a) accounts with password (invite email → set password) (b) passwordless magic link | (a) |
| D6 | Who gets tasks | Only registered users (unmatched = flagged) — confirmed by requirements | — |

**Resolved 2026-10-23:** D1 = this Mac first (Phase 0 spike; Linux x86 VM if it fails) · D2 = self-hosted faster-whisper on CPU · D3 = Google Meet only · D4 = Gmail SMTP with an app password (Mailpit in dev) · D5 = password accounts set up through an invite email.

Things I've decided without asking (say if you disagree): MySQL-backed job queue instead of Redis; polling-first Vexa integration; JWT in httpOnly cookie + bcrypt; no ORM (mysql2 + SQL migrations); Claude model configurable via env (default `claude-opus-5-5`); Mailpit for local email capture.

---

## 7. Local development setup (macOS + Docker)

Current machine: Apple Silicon (arm64), Node 18.16, Homebrew MySQL 9.4, **no Docker**.

1. **Toolchain**
   ```bash
   brew install --cask docker          # Docker Desktop (or OrbStack/Colima); enable Rosetta for x86 emulation
   brew install nvm && nvm install 22  # Node 22 LTS
   ```
2. **App database** — run MySQL 8.4 in Docker (port 3307 to avoid clashing with Homebrew MySQL on 3306), plus Mailpit (`:8025` UI, `:1025` SMTP). Defined in the root `docker-compose.yml`.
3. **Vexa** (separate checkout, outside this repo)
   ```bash
   git clone https://github.com/Vexa-ai/vexa ~/vexa
   cd ~/vexa && make all && make bot
   ```
   Then the transcription unit: `deploy/transcription` → `docker compose -f docker-compose.cpu.yml up -d`, set `TRANSCRIPTION_SERVICE_URL`/`TOKEN` in `deploy/compose/.env`. Save the printed API key into `backend/.env` as `VEXA_API_KEY`, `VEXA_BASE_URL=http://localhost:18056`.
4. **Backend**: `cd backend && npm install && npm run migrate && npm run seed && npm run dev` (api on :4000) and `npm run worker` in a second terminal.
5. **Frontend**: `cd frontend && npm install && npm run dev` (Vite on :5173, proxies `/api` → :4000).
6. **Webhook (optional)**: Vexa containers reach the host at `http://host.docker.internal:4000/api/v1/webhooks/vexa`.

Ports summary: 5173 web · 4000 api · 3307 MySQL · 8025/1025 Mailpit · 18056 Vexa gateway · 13000 Vexa terminal · 8083 transcription.
