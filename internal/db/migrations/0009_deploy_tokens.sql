-- Rexus Phase 9: deploy tokens.
--
-- A deploy token lets one app read its own environment variables at startup
-- (GET /api/v1/env). It is an API token with a fixed scope: one project, one
-- environment and optionally one service. It can read secret values inside
-- that scope and nothing else. Ordinary API tokens (kind 'api') are unchanged.
--
-- Composite foreign keys make it impossible to point at a service or
-- environment of another project, and deleting the project, service or
-- environment removes the tokens scoped to it.

ALTER TABLE api_tokens
    ADD COLUMN kind           text NOT NULL DEFAULT 'api' CHECK (kind IN ('api', 'deploy')),
    ADD COLUMN project_id     uuid REFERENCES projects (id) ON DELETE CASCADE,
    ADD COLUMN service_id     uuid,
    ADD COLUMN environment_id uuid;

ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_service_fkey FOREIGN KEY (service_id, project_id)
    REFERENCES services (id, project_id) ON DELETE CASCADE;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_environment_fkey FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id) ON DELETE CASCADE;

-- 'api' tokens have no scope; 'deploy' tokens always have a project and an
-- environment (service_id NULL = the project's own secrets, not a service's).
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (
    (kind = 'api'    AND project_id IS NULL AND service_id IS NULL AND environment_id IS NULL)
 OR (kind = 'deploy' AND project_id IS NOT NULL AND environment_id IS NOT NULL AND role = 'contributor')
);

CREATE INDEX api_tokens_project_idx ON api_tokens (project_id) WHERE project_id IS NOT NULL;
