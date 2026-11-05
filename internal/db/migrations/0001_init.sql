-- Rexus Phase 1 schema: users, sessions, projects, jobs, job runs, audit log.
-- gen_random_uuid() is built into Postgres 13+.

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               text NOT NULL,
    name                text NOT NULL DEFAULT '',
    password_hash       text NOT NULL,
    role                text NOT NULL CHECK (role IN ('owner', 'admin', 'contributor', 'viewer')),
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    totp_secret         bytea,              -- encrypted with the master key
    totp_pending_secret bytea,              -- encrypted; set during 2FA enrollment
    totp_enabled        boolean NOT NULL DEFAULT false,
    totp_last_step      bigint NOT NULL DEFAULT 0, -- blocks TOTP code replay
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Emails are unique, case-insensitive.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
-- Exactly one owner: a second owner row can never be inserted.
CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner';

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,     -- SHA-256 of the cookie token
    mfa_verified boolean NOT NULL DEFAULT false,
    ip           text NOT NULL DEFAULT '',
    user_agent   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Project key: unique, lowercase, 2-40 chars, starts with a letter.
    key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$'),
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description text NOT NULL DEFAULT '',
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_key_key ON projects (key);

CREATE TABLE jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid REFERENCES projects (id) ON DELETE CASCADE, -- optional
    name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    type            text NOT NULL DEFAULT 'http' CHECK (type IN ('http')),
    schedule        text NOT NULL,          -- cron expression, e.g. "*/5 * * * *" or "@every 10m"
    config          jsonb NOT NULL DEFAULT '{}', -- url, method, body, expected_status
    headers_enc     bytea,                  -- request headers (may hold API keys), encrypted
    timeout_seconds int NOT NULL DEFAULT 30 CHECK (timeout_seconds BETWEEN 1 AND 300),
    retries         int NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 5),
    enabled         boolean NOT NULL DEFAULT true,
    next_run_at     timestamptz,
    last_run_at     timestamptz,
    last_status     text,                   -- success | failed
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (next_run_at) WHERE enabled;
CREATE INDEX jobs_project_idx ON jobs (project_id);

CREATE TABLE job_runs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    trigger          text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
    status           text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    attempts         int NOT NULL DEFAULT 0,
    status_code      int,
    duration_ms      int,
    error            text,
    response_snippet text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);
CREATE INDEX job_runs_job_started_idx ON job_runs (job_id, started_at DESC);

CREATE TABLE audit_log (
    id            bigserial PRIMARY KEY,
    at            timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    actor         text NOT NULL,            -- email, or 'cli' / 'system'
    action        text NOT NULL,            -- e.g. auth.login, project.create
    target_type   text,
    target_id     text,
    ip            text NOT NULL DEFAULT '',
    details       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
