-- 002_extraction_pipeline: what the Phase 3 job-based extraction needs beyond 001.
--   extraction_runs: a 'queued' state (the run is created when the job is enqueued), a link to
--     its job, who requested it, attempt count, timing, and a validation summary.
--   action_items.review_details: per-item validation output (assignee candidates, deadline
--     reasoning, evidence counts) for the review UI. Flags stay in action_items.flags.

ALTER TABLE extraction_runs
  MODIFY COLUMN status ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  ADD COLUMN job_id       BIGINT UNSIGNED NULL AFTER meeting_id,
  ADD COLUMN requested_by BIGINT UNSIGNED NULL AFTER job_id,
  ADD COLUMN attempts     INT NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN summary      JSON NULL AFTER raw_response,
  ADD COLUMN started_at   DATETIME NULL AFTER created_at,
  ADD COLUMN finished_at  DATETIME NULL AFTER started_at,
  ADD KEY idx_runs_job (job_id),
  ADD CONSTRAINT fk_runs_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_runs_requester FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE action_items
  ADD COLUMN review_details JSON NULL AFTER flags;
