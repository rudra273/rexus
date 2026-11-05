-- Rexus Phase 6: backup history and small key/value settings.

-- One row per finished backup attempt. A row is written AFTER the dump
-- finishes, so a backup file never contains a half-finished "running" row of
-- itself, and restoring one doesn't show a phantom backup in progress.
CREATE TABLE backups (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name    text,                      -- NULL when the attempt failed
    size_bytes   bigint,
    status       text NOT NULL CHECK (status IN ('success', 'failed')),
    error        text,
    trigger      text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    triggered_by uuid REFERENCES users (id) ON DELETE SET NULL,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz
);
CREATE INDEX backups_started_idx ON backups (started_at DESC);

-- Settings changed in the UI (backup interval, how many backups to keep).
CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
