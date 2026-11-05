-- Rexus Phase 3: invites and password-reset links.
-- Only a SHA-256 hash of each link token is stored, never the token itself.

CREATE TABLE invites (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text NOT NULL,
    role       text NOT NULL CHECK (role IN ('admin', 'contributor', 'viewer')), -- never 'owner'
    token_hash bytea NOT NULL UNIQUE,
    invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one open invite per email; re-inviting replaces the old link.
CREATE UNIQUE INDEX invites_pending_email ON invites (lower(email)) WHERE used_at IS NULL;

CREATE TABLE password_resets (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);
