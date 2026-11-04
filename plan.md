# Rexus — Plan

> A self-hosted, open-source control panel for technical teams: projects, encrypted secrets, scheduled jobs, and health — in one place.

Status: **High-level plan / decisions log.** Details (roles matrix, schema, milestones) get finalized next.

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
| **Users & Roles** | Owner invites engineers; role-based permissions per component and per action. |
| **Alerts** | Notify on failures and upcoming expiries. |
| **Backups** | Optional backup copy of the database to local / external storage, managed from the UI. |

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

## 5. Roles & permissions (to finalize next)

- Permissions are **per component, per action**, e.g. `vault.secret.list`, `vault.secret.reveal`, `cron.job.create`, `cron.job.run`, `project.settings.edit`.
- Built-in roles: **Owner, Admin, Engineer, Viewer**.
- Access can be scoped **per project** (e.g. Engineer on Project A, Viewer on Project B).
- **Audit log** for every sensitive action — especially every secret reveal.

---

## 6. Encryption

| Layer | Approach |
|---|---|
| In transit | HTTPS (Cloudflare Tunnel / Tailscale / Caddy). |
| Secrets in DB | **Application-level envelope encryption**: each secret gets its own data key (AES-256-GCM); data keys are encrypted by the master key. The DB — even in the cloud — only ever sees ciphertext. |
| Disk | Disk/managed-DB encryption where available. |
| Backups | Not encrypted as a file (see §9). Vault secrets inside are still ciphertext, protected by the master key. |

Optional later: **seal/unseal** mode — after restart, vault stays locked until an admin enters the unseal passphrase.

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

---

## 8. Alerts & mail

**Now:** no mail server. Outgoing notifications via:
- Any **SMTP relay** (Resend, Gmail SMTP, SES, etc.) — optional.
- **Telegram, Discord, Slack** webhooks.

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
- License: TBD.

---

## 12. Next decisions

1. Roles & permissions matrix (who can do what).
2. Data model / DB schema.
3. Milestones & build order.
4. License.
