-- Rexus: optional services inside a project (frontend, backend, workers…).
--
-- A service is only an organizational scope: secrets, jobs and health checks
-- can belong to the project directly (service_id NULL) or to one service.
-- Environments stay project-wide and are shared by every service.
--
-- Composite foreign keys (x_id, project_id) make it impossible for a resource
-- to point at a service or environment of another project. They use the
-- default NO ACTION (checked at the end of the statement), not RESTRICT, so
-- deleting a project still cascades through services and their resources in
-- one statement, while deleting a non-empty service on its own is rejected.

CREATE TABLE services (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- Same rule as project keys: used in URLs and the API.
    key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$'),
    name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description    text NOT NULL DEFAULT '',
    repository_url text CHECK (length(repository_url) <= 500),  -- informational only
    root_directory text CHECK (length(root_directory) <= 200),  -- e.g. apps/web in a monorepo
    position       int NOT NULL DEFAULT 0,
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, key),
    UNIQUE (id, project_id)     -- target of the composite foreign keys below
);

ALTER TABLE environments ADD CONSTRAINT environments_id_project_key UNIQUE (id, project_id);

-- ---- secrets: explicit project_id + optional service ----

ALTER TABLE secrets ADD COLUMN project_id uuid;
UPDATE secrets s SET project_id = e.project_id FROM environments e WHERE e.id = s.environment_id;
ALTER TABLE secrets ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE secrets ADD COLUMN service_id uuid;

ALTER TABLE secrets DROP CONSTRAINT secrets_environment_id_fkey;
ALTER TABLE secrets ADD CONSTRAINT secrets_environment_fkey FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id) ON DELETE CASCADE;
ALTER TABLE secrets ADD CONSTRAINT secrets_service_fkey FOREIGN KEY (service_id, project_id)
    REFERENCES services (id, project_id);

-- Names are unique per scope: the same name may exist directly in the project
-- and in each service. (Partial indexes rather than NULLS NOT DISTINCT, which
-- needs Postgres 15 — external databases may be older.)
ALTER TABLE secrets DROP CONSTRAINT secrets_environment_id_name_key;
CREATE UNIQUE INDEX secrets_direct_name_key  ON secrets (environment_id, name)             WHERE service_id IS NULL;
CREATE UNIQUE INDEX secrets_service_name_key ON secrets (environment_id, service_id, name) WHERE service_id IS NOT NULL;
CREATE INDEX secrets_project_idx ON secrets (project_id);
CREATE INDEX secrets_service_idx ON secrets (service_id) WHERE service_id IS NOT NULL;

-- ---- jobs: a project is now required; optional service and environment ----
-- Fails if project-less jobs exist: assign them to a project (or delete them) first.

ALTER TABLE jobs ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE jobs ADD COLUMN service_id uuid, ADD COLUMN environment_id uuid;
ALTER TABLE jobs ADD CONSTRAINT jobs_service_fkey FOREIGN KEY (service_id, project_id)
    REFERENCES services (id, project_id);
ALTER TABLE jobs ADD CONSTRAINT jobs_environment_fkey FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id);
CREATE INDEX jobs_service_idx ON jobs (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX jobs_environment_idx ON jobs (environment_id) WHERE environment_id IS NOT NULL;

-- ---- health checks: optional service and environment ----

ALTER TABLE health_checks ADD COLUMN service_id uuid, ADD COLUMN environment_id uuid;
ALTER TABLE health_checks ADD CONSTRAINT health_checks_service_fkey FOREIGN KEY (service_id, project_id)
    REFERENCES services (id, project_id);
ALTER TABLE health_checks ADD CONSTRAINT health_checks_environment_fkey FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id);
CREATE INDEX health_checks_service_idx ON health_checks (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX health_checks_environment_idx ON health_checks (environment_id) WHERE environment_id IS NOT NULL;

-- ---- alerts: record the service next to the project ----

ALTER TABLE alerts_sent ADD COLUMN service_key text;
