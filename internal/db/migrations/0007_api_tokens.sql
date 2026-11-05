-- Rexus Phase 7: API tokens for external tools (a CRM, CI, a status board…).
-- Only a SHA-256 hash of each token is stored, never the token itself.

CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    prefix       text NOT NULL,             -- first few characters, so a token can be recognised in the UI
    token_hash   bytea NOT NULL UNIQUE,
    role         text NOT NULL CHECK (role IN ('contributor', 'viewer')), -- never admin or owner
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz,               -- NULL = never expires
    last_used_at timestamptz,
    last_used_ip text,
    revoked_at   timestamptz                -- revoked tokens stay listed (history), but stop working
);
