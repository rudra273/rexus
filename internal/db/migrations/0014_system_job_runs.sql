-- Built-in jobs (like the weekly data cleanup) are not user jobs: they belong to no project. Each run is logged here
-- so it can be checked from the Jobs page.
CREATE TABLE system_job_runs (
    id           bigserial PRIMARY KEY,
    job          text NOT NULL,                 -- e.g. data-cleanup
    trigger      text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
    status       text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    triggered_by uuid REFERENCES users (id) ON DELETE SET NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    duration_ms  int,
    result       jsonb NOT NULL DEFAULT '{}',   -- what the run did, e.g. {"deleted": {"audit_log": 12}}
    error        text
);
CREATE INDEX system_job_runs_job_idx ON system_job_runs (job, started_at DESC);
