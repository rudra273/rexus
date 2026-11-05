-- Rexus Phase 4: health checks, their results, and status-change events.

CREATE TABLE health_checks (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    url                   text NOT NULL,
    method                text NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
    interval_seconds      int NOT NULL DEFAULT 300 CHECK (interval_seconds BETWEEN 60 AND 86400),
    timeout_seconds       int NOT NULL DEFAULT 10 CHECK (timeout_seconds BETWEEN 1 AND 60),
    expected_status       text NOT NULL DEFAULT '200-299',
    max_response_ms       int CHECK (max_response_ms BETWEEN 1 AND 600000),  -- NULL = don't flag slow responses
    ssl_warn_days         int CHECK (ssl_warn_days BETWEEN 1 AND 365),       -- NULL = don't flag expiring certificates
    down_threshold        int NOT NULL DEFAULT 3 CHECK (down_threshold BETWEEN 1 AND 20),
    recovery_threshold    int NOT NULL DEFAULT 1 CHECK (recovery_threshold BETWEEN 1 AND 20),
    enabled               boolean NOT NULL DEFAULT true,

    -- current state, updated after every check
    status                text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'up', 'degraded', 'down')),
    consecutive_failures  int NOT NULL DEFAULT 0,
    consecutive_successes int NOT NULL DEFAULT 0,
    status_since          timestamptz,
    last_checked_at       timestamptz,
    last_response_ms      int,
    last_status_code      int,
    last_error            text,
    ssl_expires_at        timestamptz,
    next_check_at         timestamptz,

    created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_checks_due_idx ON health_checks (next_check_at) WHERE enabled;
CREATE INDEX health_checks_project_idx ON health_checks (project_id);

-- One row per probe. Pruned automatically (30 days).
CREATE TABLE health_results (
    id          bigserial PRIMARY KEY,
    check_id    uuid NOT NULL REFERENCES health_checks (id) ON DELETE CASCADE,
    checked_at  timestamptz NOT NULL DEFAULT now(),
    ok          boolean NOT NULL,           -- the request succeeded with an expected status code
    status_code int,
    response_ms int,
    error       text
);
CREATE INDEX health_results_check_time_idx ON health_results (check_id, checked_at DESC);

-- Status changes (up → down, down → up, …). Phase 5 alerts are built on these.
CREATE TABLE health_events (
    id          bigserial PRIMARY KEY,
    check_id    uuid NOT NULL REFERENCES health_checks (id) ON DELETE CASCADE,
    at          timestamptz NOT NULL DEFAULT now(),
    from_status text NOT NULL,
    to_status   text NOT NULL,
    message     text NOT NULL DEFAULT ''
);
CREATE INDEX health_events_check_idx ON health_events (check_id, at DESC);
