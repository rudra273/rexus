-- Retention: the hourly cleanup deletes by age across all checks / jobs, which the existing
-- per-check / per-job indexes can't serve. These keep that cleanup from scanning whole tables.
CREATE INDEX IF NOT EXISTS job_runs_started_idx ON job_runs (started_at);
CREATE INDEX IF NOT EXISTS health_results_checked_idx ON health_results (checked_at);
CREATE INDEX IF NOT EXISTS health_events_at_idx ON health_events (at);
