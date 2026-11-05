-- Rexus Phase 10: project access per user.
--
--   owner        sees every project.
--   admin        sees all projects (users.all_projects) or only chosen ones, never an
--                "owner only" project unless it is shared with them explicitly; always
--                sees projects they created.
--   contributor  sees only projects shared with them (project_access).
--   viewer       the same.
--
-- Upgrading changes nothing anyone can see: existing admins get "all projects" and
-- existing contributors and viewers are given every existing project; the owner
-- trims from there.

ALTER TABLE users ADD COLUMN all_projects boolean NOT NULL DEFAULT false;  -- admins only
UPDATE users SET all_projects = true WHERE role = 'admin';

ALTER TABLE projects ADD COLUMN owner_only boolean NOT NULL DEFAULT false;

CREATE TABLE project_access (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    granted_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_access_project_idx ON project_access (project_id);

INSERT INTO project_access (user_id, project_id)
SELECT u.id, p.id FROM users u CROSS JOIN projects p WHERE u.role IN ('contributor', 'viewer');

-- An invite carries the access to give the new user once the link is used.
ALTER TABLE invites ADD COLUMN all_projects boolean NOT NULL DEFAULT false;
CREATE TABLE invite_projects (
    invite_id  uuid NOT NULL REFERENCES invites (id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    PRIMARY KEY (invite_id, project_id)
);
UPDATE invites SET all_projects = true WHERE role = 'admin' AND used_at IS NULL;
INSERT INTO invite_projects (invite_id, project_id)
SELECT i.id, p.id FROM invites i CROSS JOIN projects p WHERE i.role IN ('contributor', 'viewer') AND i.used_at IS NULL;

-- Audit entries remember which project they are about, so people only see the
-- history of projects they can see. No foreign key: the history outlives the project.
ALTER TABLE audit_log ADD COLUMN project_id uuid;
UPDATE audit_log a SET project_id = p.id FROM projects p WHERE a.target_type = 'project' AND a.target_id = p.id::text;
UPDATE audit_log a SET project_id = p.id FROM projects p WHERE a.project_id IS NULL AND a.details ->> 'project' = p.key;
CREATE INDEX audit_log_project_idx ON audit_log (project_id) WHERE project_id IS NOT NULL;

-- An API token never sees more than the person who created it; it can be limited
-- further to chosen projects (all_projects = false + api_token_projects).
ALTER TABLE api_tokens ADD COLUMN all_projects boolean NOT NULL DEFAULT true;
CREATE TABLE api_token_projects (
    token_id   uuid NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    PRIMARY KEY (token_id, project_id)
);
