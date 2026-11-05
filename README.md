# Rexus

A self-hosted control panel for technical teams: projects, scheduled jobs (keepalives, pings), encrypted secrets and health — in one place. One Go binary with the React UI built in.

> Status: **Phase 7** — login + 2FA, owner setup, projects, keepalive/ping jobs with run history, the encrypted **Vault**, **team management**, **health checks with a dashboard**, **alerts** (Telegram, Slack, Discord, email), **backups** with one-step restore, and a read-only **API** for other tools. All seven planned phases are built. See [plan.md](plan.md) for the roadmap.

## Quick start (Docker)

```bash
cp .env.example .env
```

Set `REXUS_MASTER_KEY` in `.env`:

```bash
openssl rand -base64 32
```

```bash
docker compose up -d --build
```

Open the URL in `REXUS_BASE_URL` (default http://localhost:8080). Rexus starts in **setup mode** and prints a one-time setup code in its logs:

```bash
docker compose logs rexus
```

Enter the code on the setup screen to create the owner account, then set up 2FA.

**Using your own Postgres** (Supabase, Neon, RDS, local install): set `DATABASE_URL` in `.env` and run

```bash
docker compose -f docker-compose.external-db.yml up -d --build
```

## Accessing the UI

| From | How |
|---|---|
| **The same computer** | Open `REXUS_BASE_URL` — `http://localhost:8080` by default. |
| **Another device on your Wi-Fi/office network** | Open `http://<computer-ip>:<port>` (e.g. `http://192.168.0.10:8080`) and set `REXUS_BASE_URL` to that address. This is plain HTTP, so use it only on networks you trust. |
| **From anywhere, while your computer is on** | Use a tunnel (below). Nothing needs to be exposed on your router. |

**Tailscale (private — only your team's devices).** Install Tailscale on the Rexus machine and on each device, then open `http://<machine-name>:8080`. For HTTPS inside your tailnet: `tailscale serve --bg 8080`.

**Cloudflare Tunnel (public URL, login still required).** Quick test: `cloudflared tunnel --url http://localhost:8080` prints a temporary `https://….trycloudflare.com` address. For a permanent address, create a named tunnel on your own domain. Then set `REXUS_BASE_URL` to the `https://` address (this turns on secure cookies) and restart Rexus.

By default Docker publishes the port on all network interfaces. To keep Rexus reachable only from the same computer (e.g. when using a tunnel), change the port line in `docker-compose.yml` to `"127.0.0.1:${REXUS_PORT:-8080}:${REXUS_PORT:-8080}"`.

## CLI

The same binary is the CLI. With Docker, prefix commands with `docker compose exec rexus`.

| Command | What it does |
|---|---|
| `rexus serve` | Start web UI + API + scheduler |
| `rexus owner create --email you@company.com` | Create the owner (instead of the setup screen) |
| `rexus owner reset` | Lost password or 2FA: set a new password, reset 2FA, log out all owner sessions |
| `rexus owner transfer --to EMAIL` | Hand ownership to another active user (you become an admin) |
| `rexus backup now` | Take a backup now (into `REXUS_BACKUP_DIR`) |
| `rexus backup list` | List the backups in the backup folder |
| `rexus restore --file PATH` | Restore a backup into an **empty** database |
| `rexus migrate` | Run database migrations and exit |
| `rexus keygen` | Generate a `REXUS_MASTER_KEY` |

Whoever can run commands on the server can recover the owner — no secret owner key lives in code or env vars.

## Services (optional)

A project can be split into **services** — e.g. `frontend`, `backend`, `worker` — when it has several parts. Simple projects don't need any: secrets, jobs and health checks can always belong to the project directly.

- Each secret, job and check belongs to the project directly *or* to one service. Environments (`dev`, `staging`, `prod`, …) stay project-wide and are shared by all services; jobs and checks can optionally be tied to one.
- The same secret name can exist in the project and in each service (e.g. `DATABASE_URL` for both `backend` and `worker`). Nothing is inherited: a service doesn't see the project's own secrets automatically.
- A service with secrets, jobs or checks can't be deleted — move or delete them first. **Move** on a secret keeps its versions and history.
- A repository URL and root directory can be noted on a service, for reference only.
- Services organize; they don't restrict access. Anyone who can see the project sees all of its services.

## Health checks and the dashboard

Open a project and click **Add check** to watch a URL. Each check is configured in the UI:

| Setting | What it does |
|---|---|
| URL, GET or HEAD | What to request. Redirects are followed. |
| Check every | 1 minute to 24 hours (default 5 minutes). |
| Timeout | A slower response counts as a failure. |
| Expected status | `200`, a range like `200-299`, or a list like `200,301`. |
| Slow above (optional) | Marks the check **degraded** when the response takes longer than this many ms. |
| SSL warning (optional, https only) | Marks the check **degraded** when the certificate expires within this many days. |
| Down after / Up again after | How many failures (or successes) **in a row** it takes to change status. The default of 3 failures stops one blip from raising a false alarm. |

A check is 🟢 **Up**, 🟡 **Degraded** (slow, or SSL expiring), or 🔴 **Down**. A project shows the worst status among its enabled checks. Each check page has a response-time chart (1 hour to 30 days), uptime for 24 hours / 7 days / 30 days, the SSL expiry date, and a list of status changes with the reason.

The **Dashboard** lists everything that needs attention across all projects — checks that are down or degraded, failed jobs, and keys about to expire — with the most serious projects first. Probe results are kept for 30 days.

Health checks run even if you turn the scheduler module off (`REXUS_MODULE_SCHEDULER=false` only hides user cron jobs). Checks can't send custom headers yet, so point them at a URL that doesn't need a login (for example a `/health` endpoint).

## Deploy tokens: apps load their env at startup

A **deploy token** lets one app fetch its own environment variables from the Vault when it starts. Update a secret in Rexus → restart the deployment → the app gets the new value. Rexus is contacted once per start, never per user request; while the app runs, Rexus can be offline.

Create one on the project's page, under **Deploy tokens** (owner, admin or contributor): pick the environment (and a service, if the project has them). The token reads only that scope's secrets — nothing else in Rexus. Then, in your deployment platform:

1. Set `REXUS_URL` (your public Rexus address) and `REXUS_TOKEN`.
2. Make the start command load the env first:

```bash
curl -fsS -H "Authorization: Bearer $REXUS_TOKEN" "$REXUS_URL/api/v1/env" > .env && node server.js
```

The dialog shown when you create a token also has ready-made **Node.js** and **Python** snippets (a few lines that load the env at startup) and an **AI prompt** you can paste into a coding assistant to wire it up for you — the prompt contains no secrets.

`-f` makes the start fail when Rexus can't be reached, instead of running without secrets. Fetch at **startup**, not during the build: build-time values can end up inside a Docker image or a frontend bundle. Each call is audited. `?format=json` returns exact JSON; the `.env` output quotes values so Node's `--env-file`, the dotenv packages and Docker Compose read them the same way. Revoke a token any time on the project page or the **API** page.

## API for other tools (CRM, CI, status boards)

Owners and admins create **API tokens** under **API** in the sidebar. A tool then reads a project's status by its **project key** — for example a CRM that stores `acme-web` against a client and shows a green or red badge.

```bash
export REXUS_URL=https://rexus.yourcompany.com
export REXUS_TOKEN=rxt_…

curl -s -H "Authorization: Bearer $REXUS_TOKEN" $REXUS_URL/api/v1/projects/acme-web/status
```

```json
{ "key": "acme-web", "name": "Acme Website", "status": "degraded",
  "checks_total": 3, "checks_up": 2, "checks_degraded": 1, "checks_down": 0,
  "jobs_total": 2, "jobs_failing": 0, "secrets_expiring_30d": 1,
  "generated_at": "2026-11-05T12:00:00Z" }
```

`status` is `up`, `degraded`, `down`, `unknown` (not checked yet) or `none` (no checks).

| Endpoint | Returns |
|---|---|
| `GET /api/v1/health` | Checks the token works; shows its name and role |
| `GET /api/v1/env` | **Deploy tokens only.** The token's environment variables as a `.env` file (`?format=json` for JSON) |
| `GET /api/v1/projects` | All projects with their status |
| `GET /api/v1/projects/{key}/status` | The compact answer: overall status and counts |
| `GET /api/v1/projects/{key}` | Everything: services, checks, jobs, secrets expiring in 30 days |
| `GET /api/v1/projects/{key}/services` | The project's services, each with its own status and counts |
| `GET /api/v1/projects/{key}/checks` | Health checks: status, response time, 24-hour uptime, SSL expiry |
| `GET /api/v1/projects/{key}/jobs` | Cron jobs: schedule, last result |
| `GET /api/v1/projects/{key}/secrets` | Secret names, environment, tags, expiry — never values |
| `GET /api/v1/projects/{key}/secrets/{env}/{name}` | One secret of the project itself |
| `GET /api/v1/projects/{key}/services/{service}/secrets/{env}/{name}` | One secret of a service |
| `GET /api/v1/secrets/expiring?days=30` | Secrets across all projects that expire soon (or already have) |
| `POST /api/v1/projects/{key}/secrets/{env}/{name}/reveal` | The secret's value — **contributor tokens only** |
| `POST /api/v1/projects/{key}/services/{service}/secrets/{env}/{name}/reveal` | A service secret's value — **contributor tokens only** |

`status`, `checks`, `jobs` and `secrets` accept `?service=<key>` and `?environment=<name>`; use `-` for "none" (e.g. `?service=-` = only the project's own resources). Leaving a filter out means "all".

The same reference, with examples, is on the **API** page in Rexus.

**Safety**

- A token is **viewer** (status, names and expiry dates) or **contributor** (also notes, and secret values through the `reveal` call). It is never admin or owner, and the API is read-only — a leaked token can't change anything, add users or touch backups.
- You see a token **once**, when you create it. Only a hash is stored. Tokens can expire (30 days, 90 days, 1 year, never) and be **revoked** at once.
- The API never returns job URLs, headers or bodies, credentials in monitored URLs (the query string is cut off), or — for viewer tokens — notes and custom fields. Secret values come only from `reveal`.
- Only API tokens work on `/api/v1`; a browser login doesn't, and a token doesn't work on the internal API behind the UI.
- Every `reveal` is written to the **Audit log** under the token's name. Other use is logged at most once every 10 minutes per token, with a request count.
- **300 requests per minute** per token (then `429` with `Retry-After`). Twenty wrong tokens from one address lock that address out of the API for 15 minutes.
- The IP allowlist applies to the API, and **lockdown mode switches all tokens off**.
- A token keeps working if the person who created it is removed; revoke it yourself when the integration goes away.
- If you **rename a project's key**, the old key returns `404` immediately — update the tools that use it.

## Backups

Backups are plain `pg_dump` copies of the whole database, written to a folder **you** choose — a local disk, an external drive, a pendrive — never inside the Rexus folder and never into git. They are off by default, so you can switch them on only on the machine that keeps them.

**Turn them on** in `.env`, then restart Rexus:

```
REXUS_BACKUP_ENABLED=true
REXUS_BACKUP_DIR=/Volumes/MyDrive/rexus-backups
```

With Docker, `REXUS_BACKUP_DIR` is the folder on your computer; Docker mounts it into the container for you. (On Linux the folder must be writable by the container's user — `chmod 777` it, or `chown` it to uid 100.) If you unplug and re-plug a drive, restart Rexus (`docker compose restart rexus`) so Docker re-attaches it.

Then open **Backups** (owner and admins):

- **Backup now**, and an automatic schedule: every 15 minutes, hour, 6 hours (default), 24 hours, or manual only. After a failed attempt Rexus retries within 15 minutes.
- **Keep the last N** backups (default 28). Older ones are deleted automatically — only files named `rexus-YYYYMMDD-HHMMSS.dump`; anything else in the folder is never touched.
- A **"Last backup: 12m ago"** indicator is always visible in the sidebar: green when current, yellow when overdue (older than twice the interval), red when the last attempt failed or none has run yet.
- A **failed backup raises an alert** (once when backups start failing) — see **Alerts**.
- Rexus doesn't back up a database that has no accounts yet, so a freshly wiped instance can't push your good backups out with empty ones.

Each backup is written to a temporary file, checked with `pg_restore --list`, and only then renamed into place, so a full disk or a crash can't leave something that looks like a good backup. Files are created private (`0600`).

**Backups are not encrypted** — keep the folder on storage you trust. Vault secrets inside them stay encrypted with `REXUS_MASTER_KEY`, so a backup alone can't reveal them. The flip side: **a backup is useless without the master key that was in use when it was made.** Keep that key somewhere safe, separate from the backups.

**Restoring** works only into an **empty** database — it can never overwrite live data. For a new or wiped instance:

- **From the setup screen:** if Rexus finds backups in the backup folder, it offers to restore one (using the one-time setup code from the logs, like creating the owner); or
- **From the command line:**

  ```bash
  rexus restore --file /backups/rexus-20261105-120000.dump
  ```
  With Docker: `docker compose exec rexus rexus restore --file /backups/rexus-….dump`

Restores run in a single transaction (all or nothing). Afterwards you log in with the accounts from the backup. If your `REXUS_MASTER_KEY` isn't the one that made the backup, Rexus tells you so clearly. To restore a backup from a *newer* Rexus into an older one, upgrade Rexus first.

The `pg_dump` in the Docker image is PostgreSQL 17 and must be at least as new as your database; with a newer external database (some Supabase or Neon versions), Rexus shows the "server version mismatch" message.

## Alerts

Open **Alerts** (owner and admins) to choose where alerts go and what they are about.

**Channels** — add as many as you like; every alert goes to every enabled channel. Each has a **Send test** button.

| Channel | What you need |
|---|---|
| **Telegram** | A bot token from @BotFather, and the chat ID of the group (a negative number) or `@yourchannel`. Add the bot to the group first. |
| **Slack** | An Incoming Webhook URL (api.slack.com/apps → Incoming Webhooks). |
| **Discord** | A webhook URL (Channel settings → Integrations → Webhooks). |
| **Email** | One or more addresses. Needs an SMTP relay on the server (below). |

Tokens and webhook URLs are stored encrypted and are never shown again. Webhooks are only accepted for the real Slack and Discord addresses. Alert text can't ping anyone (`@everyone` and similar are neutralised).

**Events** — switch each on or off. Every alert names the project and links back to the right page in Rexus.

| Event | Default | Sent when |
|---|:-:|---|
| Site is down | on | A check fails as many times in a row as its "down after" setting. |
| Site recovered | on | A down check is up again (with how long it was down). |
| Site is slow | off | A check responds, but slower than its limit. |
| SSL certificate expiring | on | A certificate enters its warning window, then again at 7 and 1 days. |
| Secret / API key expiring | on | At 30, 7 and 1 days before the expiry date (you choose the days), and once when it has expired. |
| Cron job failed | on | A job starts failing (one alert, not one per failed run). |
| Backup failed | on | Backups start failing — a full disk, an unplugged drive… (only listed when backups are switched on). |
| New login from a new device | off | Someone logs in from an IP address or browser they haven't used before. |

**No spam.** Down, recovered and job alerts fire once, when the state changes. Expiry reminders go to each channel once per threshold (a key you re-date reminds again). A channel that keeps failing is given up on after 3 tries; the failure shows under **Recent alerts**.

**Email (SMTP).** Set these in `.env` and restart: `REXUS_SMTP_HOST`, `REXUS_SMTP_PORT` (default 587), `REXUS_SMTP_USER`, `REXUS_SMTP_PASSWORD`, `REXUS_SMTP_FROM`. Any relay works — Resend, Amazon SES, Gmail SMTP, Mailgun, or your own server. Port 465 uses TLS from the start; other ports use STARTTLS. Rexus refuses to send the password over an unencrypted connection. Once email is set up, invite and password-reset links are emailed too.

## Team and permissions

Rexus is invite-only; there is no public signup. The owner and admins add people from **Users → Invite user**: pick an email and a role, and Rexus shows a one-time link to send them. They open it, choose their own name and password, and set up 2FA. Admins never see anyone's password.

| | Owner | Admin | Contributor | Viewer |
|---|:-:|:-:|:-:|:-:|
| See dashboard, projects, secret names and expiry, job history | ✅ | ✅ | ✅ | ✅ |
| Work on secrets, jobs and checks; reveal and copy secret values | ✅ | ✅ | ✅ | ❌ |
| Create, rename and delete projects; manage a project's environments and services | ✅ | ✅ | ❌ | ❌ |
| Invite, disable, remove users; password-reset links; reset 2FA; audit log | ✅ | ✅ (only contributors and viewers) | ❌ | ❌ |
| Manage admins; transfer ownership | ✅ | ❌ | ❌ | ❌ |

### Which projects someone can see

Roles say what a person can *do*; **project access** says which projects they can *see*. Whatever isn't shared with someone answers "not found" for them — in the lists, search, the dashboard, the audit log and the API.

| | Sees |
|---|---|
| **Owner** | Every project, always — including ones an admin creates. |
| **Admin** | **All projects** or **selected projects** (the owner chooses), plus any they create themselves. Never a project marked **Owner only**. |
| **Contributor, Viewer** | Only the projects shared with them. |

- Set it when you invite someone, or later with **Users → Access**. On a project's page, the **Access** section lists who can see it and lets you share it with people.
- An admin can only share projects they can see, and only with contributors and viewers; the owner chooses what other admins see. When an admin edits someone's access, grants to projects the admin can't see are left as they are.
- **Owner only** (project page, owner only) hides a project from every admin, even ones with access to all projects, unless it is shared with them by name.
- API tokens never see more than the person who created them (checked on every request), and can be limited to chosen projects. Deploy tokens already belong to one project; creating one needs access to it.
- Alerts go to the team's shared channels, and a backup contains every project (secrets stay encrypted) — neither is filtered by project.
- Upgrading from an older version changes nothing anyone sees: existing admins get "all projects" and existing contributors and viewers keep every existing project until you trim them.

- Role changes and disabling take effect on the very next request; disabling logs the person out immediately.
- A **password-reset link** is one-time and expires in 24 hours; using it logs the user out everywhere. **Reset 2FA** forces them to enrol again at next login.
- Invite links expire after 7 days and only work once. Only a hash of each link is stored, so a link can't be shown again — use **New link** to replace it. If email is set up (see **Alerts**) the link is also emailed to them; otherwise you share it yourself.
- Everyone can change their own password and **log out of all devices** from **Settings**.
- The **Audit log** (owner and admins) records logins, secret reveals and copies, and every change — secret values are never written to it.

## Configuration

Everything is in env vars (or `.env`); see [.env.example](.env.example). Changing a value needs a restart; invalid values stop startup with a clear error. Toggles are shown read-only in **Settings**.

**IP allowlist.** `REXUS_IP_ALLOWLIST` takes comma-separated IPs or ranges, e.g. `203.0.113.5,10.0.0.0/8`; `0.0.0.0` allows everyone. Localhost is always allowed. Behind a tunnel or proxy on the same machine, Rexus reads the visitor's real IP from the `CF-Connecting-IP` or `X-Forwarded-For` header — but only when the connection itself comes from a local or private address, so a direct connection from the internet can't fake it. **Docker Desktop (Mac/Windows) hides real client IPs** (everything appears to come from Docker's own gateway), so the allowlist only works there when a tunnel/proxy supplies the header; on a Linux server it sees the true address.

**Keep `REXUS_MASTER_KEY` safe and separate from backups.** It encrypts 2FA secrets, job headers (e.g. API keys) and every vault secret. Each secret version gets its own random data key, which is encrypted with the master key — the master key is never stored in the database, so a stolen database can't be decrypted. **If you lose the master key, the vault can't be recovered.**

## Development

Needs Go 1.26+, Node 22+ and Docker.

```bash
make dev-db     # Postgres in Docker
make dev-api    # Go server on REXUS_PORT
make dev-web    # Vite dev server on :5173, proxies /api to the Go server
```

```bash
make test       # go vet + unit tests
make build      # UI + single binary at ./bin/rexus
```

For `make dev-web`, set `REXUS_PORT=8080` or change the proxy target in `web/vite.config.ts`.

## Layout

```
cmd/rexus/            entry point: serve + CLI
internal/config/      env config + toggles
internal/crypto/      AES-256-GCM, envelope encryption for the vault, tokens
internal/auth/        Argon2id passwords, TOTP, rate limiting
internal/db/          Postgres pool + embedded SQL migrations
internal/store/       all queries
internal/scheduler/   cron engine (state in DB, restart-safe)
internal/server/      HTTP API + embedded UI
web/                  React + Vite + Tailwind UI (embedded via go:embed)
```

## License

MIT (to be added before the first public release).
