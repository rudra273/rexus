# Rexus — Plan

> A self-hosted, open-source control panel for technical teams: projects, encrypted secrets, scheduled jobs, and health — in one place.

Status: **Phases 1–7 + services built.** Next: Phase 8 (Cloudflare Tunnel) and Phase 9 (deploy tokens — apps load their env from Rexus at startup); see §13.

---

## 1. What Rexus is

A technical tool for running and watching our projects. It runs on our own machine or server — nothing is forced into a public cloud. The code is open source so any company can self-host it.

**Core modules**

| Module | What it does |
|---|---|
| **Projects** | Each project holds its URLs, services, keys and jobs. |
| **Vault** | Encrypted API keys / secrets per project. Reminds before a key expires. |
| **Scheduler** | Cron jobs: ping websites, keep Supabase & other APIs awake, call webhooks, run checks. |
| **Dashboard** | Health of every project: up/down, response time, SSL expiry, failed jobs, expiring keys. |
| **Users & Roles** | Owner/Admin invite team members; 4 simple roles: Owner, Admin, Contributor, Viewer. |
| **Alerts** | Notify on failures and upcoming expiries. |
| **Backups** | Optional backup copy of the database to local / external storage, managed from the UI. |

### 1.1 Project identity

Each project has two identifiers:

| Identifier | Example | Set by | Can change? | Used for |
|---|---|---|---|---|
| **Internal ID** (UUID) | `7f3a9c2e-…` | Rexus (auto) | Never | DB relations only (internal). |
| **Project key** | `acme-web` | User, at creation | Yes (rename) | URLs (`/projects/acme-web`), API, external tools. |

External tools store the **project key** and call the API with it — e.g. `GET /api/projects/acme-web`.

**Project key rules**
- **Unique — can never be duplicated.** Enforced by a unique index in the database, not just the UI.
- **Case-insensitive** uniqueness: `Acme-Web` and `acme-web` count as the same key (stored lowercase).
- Format: lowercase letters, numbers, dashes; 2–40 chars; must start with a letter.
- **Rename allowed** (Owner/Admin). Simple: the key just changes.
  - The old key **stops working** immediately (API returns 404).
  - The UI shows a warning before renaming: *"Tools using `old-key` (e.g. your CRM) must be updated."*
- Every rename is audit-logged.

**API lookup** uses the current project key only.

**API tokens** (for external tools): Owner/Admin can create named, revocable tokens with a role (usually Viewer or Contributor). Token usage is audit-logged.

**Out of scope for now**
- Running our own mail server (see §8 — needed in future).
- Running arbitrary shell scripts from cron (security risk; maybe later, sandboxed).
- Multi-company SaaS mode. **One install = one company.**

---

## 2. Tech stack (decided)

| Part | Choice | Why |
|---|---|---|
| Backend | **Go** | Single binary, low memory (~30–50 MB), strong stdlib crypto/HTTP, great for schedulers. |
| Frontend | **React + Vite + TypeScript**, Tailwind + shadcn/ui | Built and **embedded into the Go binary** (`go:embed`). |
| Database | **PostgreSQL** (any — local, Docker, or cloud) | Connected via `DATABASE_URL`. |
| Packaging | **Single binary + Docker image** + `docker-compose.yml` | Runs on laptop, VPS, mini PC, Raspberry Pi. |
| Codebase | **One repo, one codebase** | UI + API + scheduler + CLI all in one. |

Other languages can be added later as separate services called over HTTP if ever needed. AI features (Claude / OpenAI / Ollama / MCP) are supported from Go via official SDKs.

The same binary has two faces:
- `rexus serve` — web UI + API + scheduler
- `rexus <command>` — CLI (owner setup, backup, restore, etc.)

---

## 3. Configuration

**Rule:** infrastructure, secrets **and feature toggles** → env vars. Day-to-day data (projects, jobs, users, alerts) → UI (stored in DB).

| Env var | Purpose |
|---|---|
| `REXUS_COMPANY_NAME` | Company name shown in the UI. |
| `REXUS_BASE_URL` | Public URL of the instance. |
| `REXUS_PORT` | Port Rexus listens on (default `8080`). |
| `POSTGRES_PASSWORD`, `POSTGRES_HOST_PORT` | `docker-compose.yml` only: bundled Postgres password and its localhost port. |
| `DATABASE_URL` | Any Postgres connection string. |
| `REXUS_MASTER_KEY` | Master encryption key for the vault. **Never stored in DB.** |
| `REXUS_BACKUP_DIR` | Where backups are written — a path **outside** the app/server folder (local disk, external drive, pendrive). Needed only when `REXUS_BACKUP_ENABLED=true`. |
| `REXUS_SMTP_*` | Optional SMTP relay for outgoing email. |

No secrets are hardcoded in the code. `.env` is never committed. An `.env.example` with every variable and its default is committed.

### 3.1 Toggles (env vars)

All toggles are env vars — simple, explicit, version-controlled per deployment.

- Changing a toggle = edit `.env` → **restart** Rexus.
- On start, Rexus validates every toggle; an invalid value fails startup with a clear error.
- The UI shows current toggles **read-only** under Settings (so admins can see how the instance is configured), but they can't be changed from the UI.
- Active toggles are logged on startup.

**Only these toggles exist** (all optional — if unset, the default is used):

| Env var | Values (default first) | Effect |
|---|---|---|
| `REXUS_ENV` | `production` \| `development` | Runtime environment. `development` = verbose logs, dev-friendly defaults. |
| `REXUS_2FA_MODE` | `required` \| `admins` \| `optional` \| `off` | `required`: everyone needs 2FA. `admins`: only Owner/Admin. `optional`: users choose. `off`: 2FA disabled (startup warning). |
| `REXUS_LOGIN_OWNER_ONLY` | `false` \| `true` | **Lockdown mode** — only the Owner can log in; other sessions are revoked on start. Jobs keep running. |
| `REXUS_IP_ALLOWLIST` | `0.0.0.0` \| comma-separated IPs/CIDRs | Who can access Rexus. `0.0.0.0` (or unset) = **allow all**. Example: `203.0.113.5,10.0.0.0/8`. |
| `REXUS_BACKUP_ENABLED` | `false` \| `true` | Turns the backup feature on. **Not mandatory** — e.g. set only on the local machine. Requires `REXUS_BACKUP_DIR`. |
| `REXUS_MODULE_SCHEDULER` | `true` \| `false` | Enable/disable Scheduler module (hidden from UI + API when off). |
| `REXUS_MODULE_VAULT` | `true` \| `false` | Enable/disable Vault module (hidden from UI + API when off). |

**Fixed rules (not toggles):**
- **Invites:** only Owner and Admin can invite users.
- **Backups:** only Owner and Admin can run or configure backups.

**Rule:** no toggle can lock out the Owner. Even with `REXUS_LOGIN_OWNER_ONLY=true` the Owner can log in, and the CLI (`rexus owner reset`) always works.

No other toggles. A new toggle is added only when there's a clear need, and must be listed in this table and in `.env.example`.

---

## 4. Users & authentication (decided)

- **Login:** email + password + **2FA (TOTP authenticator app)**. No Google/OAuth login.
- **2FA mandatory by default** (it's a vault); configurable via `REXUS_2FA_MODE` (see §3.1).
- **Invite-only.** No public signup. **Only Owner and Admin can invite.**
  - Owner/Admin enters email + role → Rexus generates an **invite link**.
  - User sets **their own password**. Admins never know anyone's password.
  - If SMTP is configured, the link is emailed; otherwise admin copies it and shares it manually.
- **Owner/Admin can:** invite, change roles, disable (instant logout), remove users, issue a **one-time password-reset link**, reset someone's 2FA.
- Only the **Owner** can manage Admins.
- **Security basics:** Argon2id password hashing, login rate-limiting/lockout, session timeout, "log out all devices", audit log of logins and failures.

### 4.1 Owner bootstrap (UI + CLI)

Principle: **whoever controls the server can create/recover the owner.** No owner password or secret key in env vars or code.

**How the app knows it's the first boot:** the app is stateless — the **database is the source of truth**. On every start:

```
start → connect DB → run migrations
      → does a user with role 'owner' exist?
         ├─ no  → SETUP MODE
         └─ yes → NORMAL MODE (setup permanently disabled)
```

**Setup via UI**
- In setup mode, Rexus prints a **one-time setup code** to the server logs (kept in memory only, regenerated each boot).
- Open the UI → enter the setup code → create owner (email, password, 2FA).
- After that, the setup endpoint returns 404 forever.

**Setup via CLI**
```bash
rexus owner create --email you@company.com     # prompts for password, sets up 2FA
rexus owner reset  --email you@company.com     # recovery: lost password / 2FA
rexus owner transfer --to other@company.com    # hand over ownership
```

**Safety**
- Owner creation runs in a DB transaction with a uniqueness check — two owners can never be created at once.
- Every owner action (create/reset/transfer) is audit-logged.
- Optional `REXUS_OWNER_EMAIL`: bootstrap hint only (not a secret); ignored once an owner exists.

---

## 5. Roles & permissions (decided — kept simple)

**4 fixed roles, global.** One role per user; the role applies to all projects. No custom roles, no per-project permissions (for now).

| Action | Owner | Admin | Contributor | Viewer |
|---|:-:|:-:|:-:|:-:|
| See dashboard & projects | ✅ | ✅ | ✅ | ✅ |
| Create / edit / delete projects | ✅ | ✅ | ✅ | ❌ |
| **Vault:** see secret names & expiry | ✅ | ✅ | ✅ | ✅ |
| **Vault:** reveal / copy secret value | ✅ | ✅ | ✅ | ❌ |
| **Vault:** add / edit / delete secrets | ✅ | ✅ | ✅ | ❌ |
| **Scheduler:** see jobs & run history | ✅ | ✅ | ✅ | ✅ |
| **Scheduler:** create / edit / run / delete jobs | ✅ | ✅ | ✅ | ❌ |
| **Alerts:** configure channels (Telegram, Slack, …) | ✅ | ✅ | ❌ | ❌ |
| **Backups:** backup now / interval / view | ✅ | ✅ | ❌ | ❌ |
| Invite / disable / remove users | ✅ | ✅* | ❌ | ❌ |
| Issue password-reset link / reset 2FA | ✅ | ✅* | ❌ | ❌ |
| View audit log | ✅ | ✅ | ❌ | ❌ |
| Manage Admins, transfer ownership | ✅ | ❌ | ❌ | ❌ |

\* Admins can manage **Contributors and Viewers** only — not other Admins or the Owner.

**Rules**
- Exactly **one Owner**; can't be removed, disabled or blocked by any toggle.
- Every **secret reveal and copy** is audit-logged, no matter who does it.
- Permission checks happen on the **server** for every API call — the UI only hides buttons.

**Later (only if needed):** per-project access (e.g. Contributor on Project A only).

---

## 6. Encryption

| Layer | Approach |
|---|---|
| In transit | HTTPS (Cloudflare Tunnel / Tailscale / Caddy). |
| Secrets in DB | **Application-level envelope encryption**: each secret gets its own data key (AES-256-GCM); data keys are encrypted by the master key. The DB — even in the cloud — only ever sees ciphertext. |
| Disk | Disk/managed-DB encryption where available. |
| Backups | Not encrypted as a file (see §9). Vault secrets inside are still ciphertext, protected by the master key. |

Optional later: **seal/unseal** mode — after restart, vault stays locked until an admin enters the unseal passphrase.

### 6.1 Vault structure

```
Project (acme-web)
 ├─ Environment: dev
 │   ├─ SUPABASE_URL
 │   └─ STRIPE_KEY
 ├─ Environment: staging
 └─ Environment: prod
```

**Environments**
- Every project gets **dev, staging, prod** by default.
- Owner/Admin/Contributor can add more (e.g. `preview`, `qa`) or rename/remove them.
- Secret names are unique **within an environment** (the same name can exist in dev and prod).

**Secret fields**

| Field | Notes |
|---|---|
| Name | e.g. `STRIPE_KEY`. Required. |
| Value | Encrypted (see §6). Required. |
| Expiry date | Optional. Drives expiry reminders. |
| Notes | Optional free text (e.g. "rotate via Stripe dashboard"). |
| Tags | Optional, e.g. `payment`, `third-party`. Used for filtering. |
| **Custom fields** | Users can add their own fields (e.g. `owner`, `provider`, `dashboard_url`) as name → value. Not encrypted — don't put secrets in them. |

**Version history**
- Every change to a secret's value creates a **new version** (v1, v2, v3…). Old versions are kept.
- History shows: version, who changed it, when.
- Old values can be **revealed** (same permission as reveal; audit-logged) and **restored**.
- Restore = creates a new version with the old value (history is never rewritten).
- Deleting a secret deletes all its versions (with confirmation; audit-logged).

---

## 7. Scheduler

Built into the Go binary. Jobs are **typed**, not free-form shell:

- `http_check` — URL, method, expected status, timeout (feeds the dashboard).
- `keepalive` — ping Supabase / APIs so they don't pause.
- `ssl_expiry`, `domain_expiry` — automatic checks.
- `secret_expiry_reminder` — daily; alerts at 30 / 7 / 1 days before a key expires.
- `webhook` — call any URL.
- `db_backup` — database backup copy, only when backups are enabled (see §9).

Each job has: run history, duration, logs, retries, timeout, alert on failure, and a **catch-up policy** for runs missed while the host was off/asleep. Schedule state lives in the DB so restarts are safe.

**One engine, two kinds of jobs:**
- **User jobs** — cron jobs users create (keepalive, webhook, ping). Hidden when `REXUS_MODULE_SCHEDULER=false`.
- **System jobs** — health checks, expiry reminders, backups. Always run by the same engine (backups only if enabled).

### 7.1 Health checks (configurable per check in the UI)

Each project can have one or more health checks. Every setting is configurable:

| Setting | Example / default |
|---|---|
| URL + method | `GET https://acme.com/health` |
| Interval | `1m` (default 5m) |
| Timeout | `10s` |
| **Status code** | Expected: `200`, or a list/range like `200-299` |
| **Response time** | Warn if slower than e.g. `2000ms` |
| **SSL expiry** | Warn N days before the certificate expires (default 14) |
| **Down threshold** | Mark **down** after N failures in a row (default 3) |
| **Recovery threshold** | Mark **up** again after N successes in a row (default 1) |

**Project status** (shown on the dashboard) = worst status of its checks: 🟢 Up · 🟡 Degraded (slow / SSL expiring) · 🔴 Down · ⚪ No checks.

Dashboard shows per check: current status, uptime %, response-time chart, last check time, SSL expiry date.

---

## 8. Alerts & mail

**Now:** no mail server. Outgoing notifications via:
- Any **SMTP relay** (Resend, Gmail SMTP, SES, etc.) — optional.
- **Telegram, Discord, Slack** webhooks.

### 8.1 Alert setup (configurable in the UI, Owner/Admin)

**Channels — global.** Owner/Admin add one or more channels (e.g. one Telegram group, one Slack channel). All alerts go to the global channels.

**Events — user chooses which ones send alerts:**

| Event | Default |
|---|---|
| Site / health check **down** | On |
| Site **recovered** (back up) | On |
| Site **degraded** (slow response) | Off |
| **SSL certificate** expiring | On |
| **Secret / API key** expiring (days before: default `30, 7, 1`) | On |
| **User job failed** | On |
| **Backup failed** | On |
| New user login / new device | Off |

**Every alert message includes the project info + a link:**
```
🔴 DOWN — Acme Web (acme-web)
Check: GET https://acme.com/health → timeout after 10s (3 failures in a row)
Since: 2026-11-05 14:32
Open: https://rexus.company.com/projects/acme-web
```

- No duplicate spam: one alert when the state changes (down → up), not on every failed check.
- A **Send test alert** button for each channel.

**Future (planned for sure):** a proper mail system. Approach to be decided later — e.g. integrating an existing open-source mail server (like Stalwart) on a VPS, or IMAP-based inbox. Not self-hosting SMTP from a laptop (blocked port 25, blacklisted residential IPs).

---

## 9. Database & backups

### 9.1 Any Postgres
Rexus connects to **any Postgres** via `DATABASE_URL`: Docker, local install, Supabase, Neon, RDS, etc. Migrations run automatically on start.

### 9.2 Local design (decided)
**Default: Postgres inside Docker Compose**, with data in a named volume.
- One command to run everything: `docker compose up`.
- Isolated, same on every machine, easy to reset.
- To use an external/cloud Postgres instead, just set `DATABASE_URL` and skip the bundled Postgres service.

### 9.3 Backup (optional, plain copy, no encryption)
- **Off unless `REXUS_BACKUP_ENABLED=true`** (e.g. set only on the local machine). When off, all backup UI and the backup job are hidden.
- When on, Rexus runs a scheduled `db_backup` job + on-demand backups using `pg_dump` (Postgres client bundled in the Docker image).
  - `pg_dump` is used instead of copying Postgres's raw data folder — copying the raw folder while Postgres is running can produce a corrupt backup.
- **No backup encryption for now** — keeps it simple. Backups are stored on storage we control (local disk, external drive, pendrive, other secure storage).
  - Vault secrets are **still safe** inside the backup: they're stored as ciphertext and can only be decrypted with `REXUS_MASTER_KEY`.
  - Other data in the backup (users, password hashes, project URLs, job configs) is readable — so keep backups on trusted storage.
- Written to `REXUS_BACKUP_DIR`, **outside the app/server folder**, e.g. `~/rexus-backups` or `/Volumes/USB/rexus-backups`.
  - In Docker, that host path is **mounted** into the container so files land on your disk.
- Files: `rexus-YYYYMMDD-HHMMSS.dump` + a `latest` pointer; old backups rotated by the "keep last N" setting.
- `.env` and any backup files are in **`.gitignore`** — never pushed to git.
- **Keep `REXUS_MASTER_KEY` safe and separate from the backups.** Without it, restored vault secrets can't be decrypted.
- Future option: turn on backup-file encryption if needed.

### 9.4 Backup in the UI (Owner & Admin only)
- **Always-visible "Last backup" indicator** (e.g. in the top bar / sidebar footer): `Last backup: 12 min ago`.
  - Turns **yellow** if older than 2× the interval, **red** if the last backup failed or none exists yet.
  - Visible to Owner/Admin; clicking it opens the Backups page.
- **Backups page:**
  - **Backup now** button.
  - **Interval** setting (e.g. 15m / 1h / 6h / 24h / manual only) — stored in DB, editable in UI.
  - **Keep last N** backups setting.
  - List of backup files: time, size, status (success / failed + error).
- Every backup run and settings change is audit-logged.

### 9.5 Restore from backup
- On start, if the database is **empty** and a backup is found in `REXUS_BACKUP_DIR`, Rexus offers to restore it (setup screen option + CLI) instead of a fresh setup.
- CLI:
  ```bash
  rexus backup now
  rexus backup list
  rexus restore --file ~/rexus-backups/rexus-20261104-220000.dump
  ```
- Never auto-overwrites a non-empty database.

**Future:** cloud backup targets (S3 / R2 / Backblaze / Drive) in addition to local.

---

## 10. Deployment

Same binary / image everywhere — no code changes between environments.

| Where | Notes |
|---|---|
| **Laptop** | Dev + personal use. Expose with **Cloudflare Tunnel** (reachable globally only while laptop is on) or **Tailscale** (private). Cron pauses while asleep. |
| **Office PC / mini PC / Raspberry Pi** | Always-on, private, free after hardware. |
| **VPS** (Hetzner, DigitalOcean, Vultr) | ~$5/mo, 24/7. Recommended when moving off the laptop. |
| **App platforms** (Railway, Render, Fly.io, Coolify) | Push-to-deploy. |

**Not supported:** serverless (Vercel, Netlify, Lambda) — the scheduler needs an always-on process.

---

## 11. Open source

- Public repo, self-hostable by any company.
- One install = one company; branding via env vars.
- License: **MIT** — added later, before the first public release. Build the app first.

---

## 12. Data model (high level)

All IDs are UUIDs. All tables have `created_at` / `updated_at`. Tokens are stored **hashed**, never in plain text.

**Users & access**

| Table | Key columns |
|---|---|
| `users` | email (unique, case-insensitive), name, password_hash (Argon2id), role (`owner`/`admin`/`contributor`/`viewer`), totp_secret (encrypted), totp_enabled, status (`active`/`disabled`), last_login_at |
| `invites` | email, role, token_hash, invited_by, expires_at, used_at |
| `sessions` | user_id, token_hash, ip, user_agent, expires_at, revoked_at |
| `password_resets` | user_id, token_hash, expires_at, used_at |
| `api_tokens` | name, token_hash, role, created_by, last_used_at, expires_at, revoked_at; Phase 9 adds kind (`api`/`deploy`) + project/service/environment scope |

**Projects & vault**

| Table | Key columns |
|---|---|
| `projects` | key (unique, lowercase), name, description, created_by |
| `environments` | project_id, name — unique (project_id, name) |
| `secrets` | environment_id, name, expires_at, notes, tags (text[]), custom_fields (jsonb), current_version — unique (environment_id, name) |
| `secret_versions` | secret_id, version, ciphertext, nonce, wrapped_data_key, created_by — unique (secret_id, version) |

**Scheduler & health**

| Table | Key columns |
|---|---|
| `jobs` | project_id (optional), name, type, schedule (cron), config (jsonb), enabled, timeout, retries, next_run_at, last_run_at |
| `job_runs` | job_id, started_at, finished_at, status, duration_ms, output / error |
| `health_checks` | project_id, name, url, method, interval, timeout, expected_status, max_response_ms, ssl_warn_days, down_threshold, recovery_threshold, current status, consecutive failures/successes, ssl_expires_at, last_checked_at |
| `health_results` | check_id, checked_at, ok, status_code, response_ms, error (old rows pruned automatically) |

**Alerts, backups, system**

| Table | Key columns |
|---|---|
| `alert_channels` | type (`telegram`/`discord`/`slack`/`email`), name, config (encrypted — webhook URLs are sensitive), enabled |
| `alert_events` | event, enabled, options (jsonb, e.g. reminder days) |
| `alerts_sent` | event, project_id, channel_id, message, status, sent_at |
| `backups` | file_name, size, status, error, trigger (`manual`/`scheduled`), triggered_by, started_at, finished_at |
| `settings` | key, value (jsonb) — e.g. backup interval, keep-last-N |
| `audit_log` | at, actor (user or API token), action, target_type, target_id, ip, details (jsonb) |

---


## 13. Build phases

**Built:** Phases 1–7 (foundation + keepalive jobs, Vault, team, health checks + dashboard, alerts, backups, read-only API) and optional **services** per project. How they work is in the README and in §1–12 above; the detailed build notes are in git history.

**Next:** Phase 8 (Cloudflare Tunnel) → Phase 9 (deploy tokens: apps load their env from Rexus at startup). Phase 10 (Rexus pushes secrets into deployments) is future.

### Phase 8 — Public HTTPS address with Cloudflare Tunnel

**Goal:** cloud deployments (Vidyakalp etc.) can reach Rexus over HTTPS, without opening any port on the router.

**Setup (one time, no code):**
1. Domain on Cloudflare (e.g. `example.com`).
2. Install `cloudflared` on the Rexus machine → `cloudflared tunnel login` → `cloudflared tunnel create rexus`.
3. Route a hostname to it: `cloudflared tunnel route dns rexus rexus.example.com`, and point the tunnel's ingress at `http://localhost:8080`.
4. Run it as a service so it starts on boot (`cloudflared service install`), or as a `cloudflared` container in `docker-compose.yml`.
5. In `.env`: `REXUS_BASE_URL=https://rexus.example.com` (turns on secure cookies) → restart Rexus.
6. Publish Rexus's port on `127.0.0.1` only, so it's reachable just through the tunnel.

**Lock down the UI (recommended):** put **Cloudflare Access** (Zero Trust, free tier) in front of everything **except `/api/v1/*`**. The team logs in to the UI through Access (email code / Google) *and* Rexus's own login + 2FA. `/api/v1` stays open to the internet, protected by tokens, rate limits and the bad-token lockout.

**Things to know:**
- **Deploys need Rexus online.** If Rexus runs on a laptop, a deploy/restart fails while the laptop is off or asleep. Running apps are not affected. Move Rexus to an always-on box/VPS when this starts to matter.
- **IP allowlist:** `REXUS_IP_ALLOWLIST` also applies to the API. Cloud platforms don't have fixed IPs, so keep it at `0.0.0.0` (and rely on Cloudflare Access for the UI) — or list the platform's outbound IPs if it has them.
- Real client IPs come from `CF-Connecting-IP`; Rexus already trusts that header when the connection comes from a local/private address (where `cloudflared` runs).

**Code changes:** none required. Optional: a `cloudflared` service in `docker-compose.yml` (off by default, `TUNNEL_TOKEN` in `.env`) and a README section.

**Done when:** `curl https://rexus.example.com/api/v1/health -H "Authorization: Bearer …"` works from outside, and the UI asks for Cloudflare Access login first.

### Phase 9 — Deploy tokens: apps load their env at startup

**The flow:**
```
Update a secret in the Vault → restart the deployment → app fetches its env from Rexus once at startup → app runs
```
Rexus is called **once per start/restart**, never per user request. While the app runs, Rexus can be offline.

**1. Deploy tokens** (extend the existing `api_tokens`, no new auth system)
- New columns: `kind` (`api` | `deploy`), `project_id`, `service_id` (nullable = the project's own secrets), `environment_id`. Scope columns are required for `deploy`, empty for `api`. DB checks enforce this; foreign keys cascade when the project/service/environment is deleted.
- Same format and protections as today: `rxt_…`, stored only as a hash, shown once, expiry (30d / 90d / 1y / never), revoke, rate limit, bad-token lockout, lockdown mode, IP allowlist, last used time + IP.
- A deploy token can call **only** `GET /api/v1/env` (and `GET /api/v1/health`). Every other `/api/v1` route returns `403`. An `api` token cannot call `/env`.
- Who can create/revoke: Owner, Admin and Contributor (same people who can reveal secrets). Viewers can only see the list.
- Separate limit from API tokens: max 100 active deploy tokens.

**2. Endpoint**
```
GET /api/v1/env                → text/plain, .env format
GET /api/v1/env?format=json    → {"KEY": "value", …}
```
- Returns the **current version** of every secret in the token's project + environment (+ service, if set). Nothing else: no notes, tags, history.
- `.env` output: `KEY="value"` with quotes/newlines escaped so any value round-trips; sorted by name.
- `Cache-Control: no-store`.
- Audit-logged on **every** call: token, IP, number of secrets (not names/values).
- Empty scope returns an empty file with `200` (not an error).

**3. UI — Vault page → project → "Deploy tokens"**
- **Create:** name (e.g. `vidyakalp-prod-backend`), environment, service (optional), expiry → the token is shown once, with a ready start command to copy.
- **List:** name, prefix, scope, created by, last used (time + IP), expiry, **Revoke**.
- **API page:** a read-only list of *all* deploy tokens across projects (with revoke), next to the existing API tokens; API docs gain the `/env` endpoint.

**4. App side** (set once per project, in the deployment platform)
- Env vars: `REXUS_URL`, `REXUS_TOKEN`.
- Start command:
  ```bash
  curl -fsS -H "Authorization: Bearer $REXUS_TOKEN" "$REXUS_URL/api/v1/env" > .env && node server.js
  ```
  `-f` makes startup fail when Rexus can't be reached, instead of running with no secrets.
- README gets copy-paste examples (Node, Docker entrypoint, a VPS/systemd service).
- **Note:** fetch at **startup**, not at build time — values fetched during a build can end up inside the Docker image or the frontend bundle.

**5. Tests**
- Deploy token sees only its scope: not other environments, other services, the project's own secrets when scoped to a service, or other projects.
- Deploy token gets `403` on every other `/api/v1` route; API token gets `403` on `/env`.
- Revoked / expired tokens stop working; lockdown mode blocks them.
- `.env` escaping round-trips values with quotes, `$`, `#`, spaces and newlines.
- Deleting the project/service/environment removes its deploy tokens.
- Backup → restore still works with the new columns.

**Done when:** a project on a cloud platform starts with only `REXUS_URL` + `REXUS_TOKEN` set, and after changing a secret in the Vault and restarting, the app uses the new value.

### Phase 10 — Rexus updates secrets in deployments (future)

When a secret changes in the Vault, Rexus pushes it into the deployment's platform env vars (e.g. Vercel, Render, Railway, GitHub Actions secrets) and optionally triggers a redeploy. Platform API keys stored encrypted in the Vault. Not designed yet — decide platforms first.

### Later (not planned in detail yet)
- Mail system (§8).
- Cloud backup targets (S3 / R2 / Backblaze / Drive).
- Vault seal/unseal mode.
- Per-project access for users.
- Explicit secret sharing between services; job credentials bound to vault secrets; per-service alert routing; cross-project moves.
- MIT license + public open-source release.
