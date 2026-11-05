# Optional services and environment management in Rexus

Status: proposed for review; no implementation approved or performed. Revised after validation against the current schema (`internal/db/migrations/0001`–`0007`), `internal/store/*`, and `internal/server/server.go`.

Context: Rexus has no real users or production data yet — only the owner account and test projects. This proposal therefore does not carry legacy-API compatibility, staged data migration, or rollback-reconciliation work. It still adds a new migration (`0008_services.sql`) instead of editing applied ones, because existing databases have already recorded `0001`–`0007` in `schema_migrations`.

## 1. Concerns and requirements

I want Rexus to support projects that contain multiple repositories or application components, such as a frontend, backend, and supporting workers. Each component may need its own configuration for development, staging, and production.

Currently, configuration is organized at the project/environment level. The workarounds are to create environments named after services or create a separate project for every repository. Neither should be necessary simply to separate service configuration.

Requirements:

- **Services must be optional.** A simple project must allow secrets, scheduled jobs, and health checks directly inside the project without creating a service.
- **Multiple services must fit within one project.** Larger applications keep a unified project view while separating service-specific resources.
- **Environment and service remain distinct concepts.** Development, staging, and production describe environments; frontend, backend, and workers describe services.
- **Repositories do not dictate the architecture.** One repository may contain several services, and some services may have no repository.
- **The architecture works across modules.** Vault, scheduler, health checks, alerts, and future integrations — not only environment-variable storage.
- **Sharing is deliberate.** Common configuration is reusable without unintentionally exposing backend credentials to frontend services.
- **Projects without services behave exactly as before.** Introducing services must not force restructuring of simple projects.
- **The solution is maintainable.** Avoid both naming-convention workarounds and a generic framework that is unnecessarily complicated for the current product.

HashiCorp Vault was considered as an architectural reference. Its path-based organization and access policies are useful ideas, but Rexus also manages jobs and monitoring, so secrets organization alone is not the entire problem.

## 2. Architecture

### Recommendation

Keep **Project as the required owner** of every resource. Introduce **Service as an optional organizational scope** within a project. Keep **Environment as a project-owned dimension** applied to both direct project resources and service resources.

Services are organizational entities in Rexus; creating one does not provision or deploy anything.

```text
Project: Commerce
├── Environments: dev, staging, prod
├── Direct project resources
│   ├── Secrets grouped by environment
│   ├── Nightly reporting job
│   └── Main website health check
├── Service: frontend
│   ├── Optional repository URL and root directory
│   ├── Secrets grouped by environment
│   └── Health checks and scheduled jobs
└── Service: backend
    ├── Optional repository URL and root directory
    ├── Secrets grouped by environment
    └── Health checks and scheduled jobs
```

There is no mandatory default service. "Project directly" is a UI label for resources with no service, not an artificial service record.

### Resource ownership and scope

| Resource | Project | Service | Environment |
|---|---|---|---|
| Secret | Required | Optional | Required |
| Scheduled job | **Required (changed — currently optional)** | Optional | Optional |
| Health check | Required | Optional | Optional |
| Future resource types | Required | Defined by that module | Defined by that module |

A resource has exactly one owning project and at most one service and one environment. A job or check without an environment is unscoped; it does not run in every environment or inherit one dynamically. The same logical job needed in staging and production is two separately configured jobs; templates can come later if justified.

**Change to jobs:** today `jobs.project_id` is nullable (global jobs exist) and `UpdateJob` can freely change a job's project. Under this proposal every job belongs to a project, and changing a job's project is no longer a plain field edit — it becomes the explicit move described under *Resource moves*. Making `project_id NOT NULL` is what makes the composite foreign keys below meaningful: Postgres skips a multi-column foreign key check when any of its columns is NULL, so a job with `project_id = NULL` and a `service_id` would otherwise escape validation entirely.

Services and environments are separate children of the project. Do not duplicate environments under each service, and do not add a service×environment join table until there is real configuration for that pair (such as deployment enablement).

### Data model

Keep separate domain tables for secrets, jobs, and health checks. Share ownership validation and scope-filtering helpers in the store layer rather than introducing a universal resource table or generic JSON settings.

Sketch of `0008_services.sql`:

```sql
CREATE TABLE services (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$'), -- same rule as project keys
    name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description     text NOT NULL DEFAULT '',
    repository_url  text,
    root_directory  text,
    position        int NOT NULL DEFAULT 0,
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, key),
    UNIQUE (id, project_id)            -- target for composite foreign keys
);

ALTER TABLE environments ADD CONSTRAINT environments_id_project_key UNIQUE (id, project_id);

-- Secrets: add an explicit project_id so both relationships are enforced declaratively.
ALTER TABLE secrets ADD COLUMN project_id uuid;
UPDATE secrets s SET project_id = e.project_id FROM environments e WHERE e.id = s.environment_id;
ALTER TABLE secrets ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE secrets ADD COLUMN service_id uuid;
ALTER TABLE secrets DROP CONSTRAINT secrets_environment_id_fkey;
ALTER TABLE secrets ADD FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id) ON DELETE CASCADE;   -- unchanged behaviour: deleting an environment deletes its secrets
ALTER TABLE secrets ADD FOREIGN KEY (service_id, project_id)
    REFERENCES services (id, project_id);                         -- NO ACTION: blocks deleting a non-empty service
ALTER TABLE secrets DROP CONSTRAINT secrets_environment_id_name_key;
CREATE UNIQUE INDEX secrets_direct_name_key  ON secrets (environment_id, name)             WHERE service_id IS NULL;
CREATE UNIQUE INDEX secrets_service_name_key ON secrets (environment_id, service_id, name) WHERE service_id IS NOT NULL;

-- Jobs: project becomes required. The migration fails if project-less jobs exist;
-- assign or delete those test jobs before upgrading.
ALTER TABLE jobs ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE jobs ADD COLUMN service_id uuid, ADD COLUMN environment_id uuid;
ALTER TABLE jobs ADD FOREIGN KEY (service_id, project_id)     REFERENCES services (id, project_id);
ALTER TABLE jobs ADD FOREIGN KEY (environment_id, project_id) REFERENCES environments (id, project_id);

-- Health checks: project_id is already NOT NULL.
ALTER TABLE health_checks ADD COLUMN service_id uuid, ADD COLUMN environment_id uuid;
ALTER TABLE health_checks ADD FOREIGN KEY (service_id, project_id)     REFERENCES services (id, project_id);
ALTER TABLE health_checks ADD FOREIGN KEY (environment_id, project_id) REFERENCES environments (id, project_id);

CREATE INDEX secrets_service_idx       ON secrets (service_id)       WHERE service_id IS NOT NULL;
CREATE INDEX jobs_service_idx          ON jobs (service_id)          WHERE service_id IS NOT NULL;
CREATE INDEX health_checks_service_idx ON health_checks (service_id) WHERE service_id IS NOT NULL;

-- Alerts: record the service alongside the project for history and messages.
ALTER TABLE alerts_sent ADD COLUMN service_key text;
```

Constraint names above (`secrets_environment_id_fkey`, `secrets_environment_id_name_key`) are Postgres's generated defaults for `0002_vault.sql`; confirm them against a real database before finalizing.

Notes on the constraints:

- **Same-project guarantee lives in the database.** The composite foreign keys make it impossible for a resource to reference a service or environment from another project, regardless of which handler or API wrote it. Handlers still validate first so users get clear error messages.
- **Use the default `NO ACTION`, not `RESTRICT`, on service and job/check-environment foreign keys.** Deleting a project cascades to its services *and* to its secrets, jobs, and checks in the same statement. `RESTRICT` is checked immediately and can reject that cascade mid-way; `NO ACTION` is checked at the end of the statement, so project deletion still works while deleting a non-empty service by itself is blocked.
- **Deleting an environment** keeps today's behaviour for secrets (they cascade, including service secrets — the UI confirmation must say so). Jobs and checks scoped to that environment block the deletion until they are moved or unscoped. A cascading `SET NULL` was rejected because on a composite key it would also null `project_id`; the column-list form `SET NULL (environment_id)` needs Postgres 15, and external databases may be older.
- **Partial unique indexes, not `UNIQUE NULLS NOT DISTINCT`.** The latter also requires Postgres 15. The two partial indexes let frontend and backend use the same variable name while preventing duplicates in any one scope, including direct project secrets.
- **Encryption is unaffected.** The secret encryption context is `secretID + version` (`crypto.SecretAAD`), so adding scope columns or moving a secret between scopes never requires re-encrypting values.
- Repository metadata is informational only: it grants no repository access, syncs no code, and triggers no deployment. Several services may reference the same repository with different root directories.

### Configuration and sharing semantics

Direct project secrets are a separate scope, not inherited defaults. A service's effective configuration is only its own entries.

- Do not merge project secrets into every service automatically.
- Do not fall back from a missing service secret to a project secret of the same name.

Explicit sharing (typed references between secrets) is deferred; see *Deferred work*.

### Scheduler and health-check integration

Jobs and checks keep their current execution behaviour. Service and environment associations only add organization, filtering, and labels in the first release; the scheduler and health engines do not change.

### Alerts and audit

- Alert messages and `alerts_sent` include the service key when the source resource has one (e.g. "Commerce / backend: check *API* is down").
- Audit events for resource changes include `service` and `environment` in `details`.
- Per-service alert routing (different channels per service) is deferred.

### Permissions

The current global role model (`users.role`, and `api_tokens.role` with no project limit) stays unchanged. **Services are organization, not access isolation**, and the UI and docs must not present them as such. Scoped grants are deferred.

### User experience

- Project creation stays as it is and does not ask for a service. A project gets a **Services** tab with an optional "Add service" action.
- Resource forms gain a **Service** selector defaulting to "Project directly." Secrets require an environment; jobs and checks may select an environment or stay unscoped.
- Project pages aggregate direct and service resources. Filters distinguish **All services**, **Project directly**, and a specific service; environment filters distinguish **All environments**, **Unscoped**, and a specific environment.
- Resources, audit entries, and alert history show their scope labels.
- Service health aggregates that service's enabled checks; project health keeps aggregating all of the project's checks.

### API

There are no external consumers yet, so routes are designed for clarity rather than compatibility.

Token API (`/api/v1`):

```text
GET  /api/v1/projects/{project}/secrets                                    # all secrets, each with service + environment metadata
GET  /api/v1/projects/{project}/secrets/{env}/{name}                       # direct project secret only
POST /api/v1/projects/{project}/secrets/{env}/{name}/reveal
GET  /api/v1/projects/{project}/services
GET  /api/v1/projects/{project}/services/{service}/secrets/{env}/{name}    # service secret only
POST /api/v1/projects/{project}/services/{service}/secrets/{env}/{name}/reveal
```

The exact-name routes never search across scopes: the direct route only matches `service_id IS NULL`, the service route only matches that service. Collection routes for jobs and checks accept `?service=` and `?environment=` filters, where `service=-` / `environment=-` mean "none" — distinct from omitting the parameter ("all").

Session API: add `GET/POST /api/projects/{key}/services`, `PATCH/DELETE /api/services/{id}`, and accept `service_id` / `environment_id` on the existing create/update bodies for secrets, jobs, and checks.

### Resource moves and deletion

- Moving a resource between "Project directly" and a service, or between services, is an explicit, audited action within the same project. Name conflicts in the destination are rejected (the unique indexes enforce this; the handler reports it clearly). Secret history and version records move with the secret unchanged.
- Changing a job's project is no longer allowed through a plain update. A cross-project move is a separate future workflow.
- Deleting a non-empty service is blocked (enforced by the foreign keys); the user must first move or delete its resources. Deleting a project still deletes everything in it, as today.

## 3. Implementation plan

1. **Migration `0008_services.sql`** as sketched above, after assigning or deleting any project-less test jobs.
2. **Store layer:** `services` CRUD; scope fields on `Secret`, `Job`, `HealthCheck`; shared scope filter helper (`all` / `none` / specific id); `SecretByName` split into direct and service lookups; move operations.
3. **Handlers and API:** service routes, scope fields on create/update, new `/api/v1` service routes, job project changes routed through the move operation, alert and audit scope details.
4. **UI:** Services tab, scope selectors, scope filters, scope labels, move action, delete-blocked messaging.
5. **Tests:** see validation criteria.

## 4. Validation criteria

- A project with no services behaves as before across secrets, jobs, checks, and the API.
- One project can hold direct resources alongside frontend and backend resources.
- The same secret name can exist directly and in several services, and every exact-name lookup returns the intended one.
- Cross-project service or environment references are rejected by the database, even when inserted directly with SQL.
- A job cannot be created without a project.
- "None" filters (`-`) are distinct from "all" (parameter omitted).
- Moves preserve secret ID, versions, and decryptability, and reject destination name conflicts.
- Deleting a non-empty service fails; deleting its project succeeds and removes everything.
- Deleting an environment removes its secrets and is blocked by jobs/checks scoped to it.
- Alert history and audit entries show the service.
- Backup → restore into an empty database works with the new schema.

## 5. Deferred work

These are out of scope for the first release. They are recorded so the first design doesn't block them.

- **Explicit secret sharing.** Typed references to an existing secret ID with an explicit destination variable name; same project and environment only; duplicate destination names rejected rather than resolved by precedence; no reference-to-reference chains; missing or deleted sources fail clearly.
- **Scheduler secret bindings.** Bind a secret to a job credential field (for example an `Authorization` header) instead of storing it in `jobs.headers_enc`. Requires a defined execution identity first — never an unrestricted system identity. Resolve once at execution start, record the version used, redact values from logs and errors, and refuse to send the request when a secret is missing or denied. Health checks can reuse this if authenticated checks are added.
- **Scoped permissions.** Grants by project, optional service, optional environment, and operation (view metadata, reveal value, modify, execute), applied consistently to lists, search, history, exports, the API, and background execution. A token scoped to one service must not see direct project secrets unless separately granted.
- **Per-service alert routing**, job templates across environments, a service×environment table for deployment settings, and cross-project moves.

## 6. References

Railway separates project environments and services, and shared variables are explicitly attached to consuming services. Render groups services into project environments and supports linked configuration groups. HashiCorp Vault uses secret paths and policies, with namespaces for stronger administrative separation. These are conceptual references, not claims about those products' internal implementations.

- [Railway environments](https://docs.railway.com/environments)
- [Railway variables and explicit sharing](https://docs.railway.com/variables)
- [Render projects and environments](https://render.com/docs/projects)
- [Render environment variables and groups](https://render.com/docs/configure-environment-variables)
- [HashiCorp Vault static secrets guidance](https://developer.hashicorp.com/validated-designs/vault/administration-guide/static-secrets-management)
- [HashiCorp Vault namespace and mount-path design](https://developer.hashicorp.com/vault/docs/enterprise/namespaces/namespace-structure)
