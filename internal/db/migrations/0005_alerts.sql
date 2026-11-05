-- Rexus Phase 5: alert channels, per-event settings, and a delivery log.

CREATE TABLE alert_channels (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type       text NOT NULL CHECK (type IN ('telegram', 'discord', 'slack', 'email')),
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    config_enc bytea NOT NULL,              -- bot tokens / webhook URLs are secrets: encrypted with the master key
    enabled    boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A row exists only once someone changes an event; otherwise the built-in default applies.
CREATE TABLE alert_events (
    event      text PRIMARY KEY,
    enabled    boolean NOT NULL,
    options    jsonb NOT NULL DEFAULT '{}', -- e.g. {"days": [30, 7, 1]} for key-expiry reminders
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts_sent (
    id           bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    event        text NOT NULL,             -- e.g. check.down, secret.expiring, test
    channel_id   uuid REFERENCES alert_channels (id) ON DELETE SET NULL,
    channel_name text NOT NULL,
    project_key  text,
    title        text NOT NULL,
    status       text NOT NULL CHECK (status IN ('sent', 'failed')),
    error        text,
    dedupe_key   text                       -- set for reminders, so each one goes out once per channel
);
CREATE INDEX alerts_sent_at_idx ON alerts_sent (at DESC);
CREATE INDEX alerts_sent_dedupe_idx ON alerts_sent (dedupe_key, channel_id) WHERE dedupe_key IS NOT NULL;

-- Why a health check became degraded: 'slow' or 'ssl' (alerts treat them differently).
ALTER TABLE health_events ADD COLUMN reason text NOT NULL DEFAULT '';
