-- 001_init: full schema from docs/PLANNING.md §3.
-- Invite / password-reset token tables are deferred to the phase that implements invitations.

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  full_name     VARCHAR(200) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role          ENUM('admin','employee') NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_aliases (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  alias            VARCHAR(200) NOT NULL,
  normalized_alias VARCHAR(200) NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alias_user (normalized_alias, user_id),
  KEY idx_alias (normalized_alias),
  CONSTRAINT fk_alias_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meetings (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title             VARCHAR(255) NOT NULL,
  meeting_url       VARCHAR(1024) NOT NULL,
  platform          VARCHAR(32) NULL,
  native_meeting_id VARCHAR(255) NULL,
  vexa_meeting_id   VARCHAR(64) NULL,
  scheduled_at      DATETIME NULL,
  started_at        DATETIME NULL,
  ended_at          DATETIME NULL,
  status            ENUM('draft','bot_requested','bot_joining','in_progress','ended',
                         'transcript_ready','extracting','review_pending','approved',
                         'emails_sent','failed') NOT NULL DEFAULT 'draft',
  language_hint     VARCHAR(10) NULL,
  last_error        TEXT NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_meetings_status (status),
  UNIQUE KEY uq_meetings_native (platform, native_meeting_id, scheduled_at),
  CONSTRAINT fk_meetings_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meeting_participants (
  meeting_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (meeting_id, user_id),
  CONSTRAINT fk_mp_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transcripts (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meeting_id         BIGINT UNSIGNED NOT NULL,
  full_text          MEDIUMTEXT NULL,
  raw_json           JSON NULL,
  detected_languages JSON NULL,
  segment_count      INT NOT NULL DEFAULT 0,
  fetched_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transcripts_meeting (meeting_id),
  CONSTRAINT fk_transcripts_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE transcript_segments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transcript_id   BIGINT UNSIGNED NOT NULL,
  vexa_segment_id VARCHAR(128) NOT NULL,
  speaker         VARCHAR(200) NULL,
  text            TEXT NOT NULL,
  start_sec       DECIMAL(10,2) NULL,
  end_sec         DECIMAL(10,2) NULL,
  language        VARCHAR(10) NULL,
  confidence      DECIMAL(4,3) NULL,
  UNIQUE KEY uq_segment (transcript_id, vexa_segment_id),
  CONSTRAINT fk_segments_transcript FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE extraction_runs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meeting_id     BIGINT UNSIGNED NOT NULL,
  model          VARCHAR(64) NOT NULL,
  prompt_version VARCHAR(16) NOT NULL,
  status         ENUM('running','succeeded','failed') NOT NULL DEFAULT 'running',
  input_tokens   INT NULL,
  output_tokens  INT NULL,
  raw_response   JSON NULL,
  error          TEXT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_runs_meeting (meeting_id),
  CONSTRAINT fk_runs_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE action_items (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meeting_id        BIGINT UNSIGNED NOT NULL,
  extraction_run_id BIGINT UNSIGNED NULL,
  title             VARCHAR(255) NOT NULL,
  description       TEXT NULL,
  assignee_name_raw VARCHAR(200) NULL,
  assignee_user_id  BIGINT UNSIGNED NULL,
  assignee_match    ENUM('exact','alias','fuzzy','manual','none') NOT NULL DEFAULT 'none',
  due_date          DATE NULL,
  due_date_raw      VARCHAR(200) NULL,
  priority          ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  review_status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  task_status       ENUM('todo','in_progress','blocked','done') NOT NULL DEFAULT 'todo',
  flags             JSON NULL,
  ai_confidence     DECIMAL(4,3) NULL,
  approved_by       BIGINT UNSIGNED NULL,
  approved_at       DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_items_meeting_review (meeting_id, review_status),
  KEY idx_items_assignee_status (assignee_user_id, task_status),
  CONSTRAINT fk_items_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_run FOREIGN KEY (extraction_run_id) REFERENCES extraction_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_items_assignee FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_items_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE action_item_evidence (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action_item_id BIGINT UNSIGNED NOT NULL,
  excerpt        TEXT NOT NULL,
  speaker        VARCHAR(200) NULL,
  start_sec      DECIMAL(10,2) NULL,
  segment_id     BIGINT UNSIGNED NULL,
  CONSTRAINT fk_evidence_item FOREIGN KEY (action_item_id) REFERENCES action_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_evidence_segment FOREIGN KEY (segment_id) REFERENCES transcript_segments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE email_messages (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meeting_id          BIGINT UNSIGNED NOT NULL,
  recipient_user_id   BIGINT UNSIGNED NOT NULL,
  recipient_email     VARCHAR(255) NOT NULL,
  subject             VARCHAR(255) NOT NULL,
  html_body           MEDIUMTEXT NOT NULL,
  text_body           MEDIUMTEXT NOT NULL,
  idempotency_key     CHAR(64) NOT NULL,
  status              ENUM('queued','sending','sent','failed','retry') NOT NULL DEFAULT 'queued',
  provider            VARCHAR(20) NULL,
  provider_message_id VARCHAR(255) NULL,
  attempt_count       INT NOT NULL DEFAULT 0,
  last_error          TEXT NULL,
  next_attempt_at     DATETIME NULL,
  sent_at             DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_idempotency (idempotency_key),
  KEY idx_email_status (status, next_attempt_at),
  CONSTRAINT fk_email_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_email_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE email_message_items (
  email_message_id BIGINT UNSIGNED NOT NULL,
  action_item_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (email_message_id, action_item_id),
  CONSTRAINT fk_emi_message FOREIGN KEY (email_message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_emi_item FOREIGN KEY (action_item_id) REFERENCES action_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE email_attempts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email_message_id  BIGINT UNSIGNED NOT NULL,
  attempted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success           BOOLEAN NOT NULL,
  error             TEXT NULL,
  provider_response JSON NULL,
  CONSTRAINT fk_attempts_message FOREIGN KEY (email_message_id) REFERENCES email_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE jobs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type         VARCHAR(64) NOT NULL,
  payload      JSON NULL,
  dedupe_key   VARCHAR(191) NULL,
  status       ENUM('pending','running','succeeded','failed','dead') NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at    DATETIME NULL,
  locked_by    VARCHAR(64) NULL,
  last_error   TEXT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jobs_dedupe (dedupe_key),
  KEY idx_jobs_claim (status, run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_logs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,
  action        VARCHAR(64) NOT NULL,
  entity_type   VARCHAR(32) NOT NULL,
  entity_id     BIGINT UNSIGNED NULL,
  before_json   JSON NULL,
  after_json    JSON NULL,
  ip            VARCHAR(45) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
