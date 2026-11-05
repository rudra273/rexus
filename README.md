# Rexus

A self-hosted control panel for technical teams: projects, scheduled jobs (keepalives, pings), encrypted secrets and health — in one place. One Go binary with the React UI built in.

> Status: **Phase 6** — login + 2FA, owner setup, projects, keepalive/ping jobs with run history, the encrypted **Vault**, **team management**, **health checks with a dashboard**, **alerts** (Telegram, Slack, Discord, email), and **backups** with one-step restore. See [plan.md](plan.md) for the full roadmap.

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
| Create/edit projects, secrets, jobs; reveal and copy secret values | ✅ | ✅ | ✅ | ❌ |
| Invite, disable, remove users; password-reset links; reset 2FA; audit log | ✅ | ✅ (only contributors and viewers) | ❌ | ❌ |
| Manage admins; transfer ownership | ✅ | ❌ | ❌ | ❌ |

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
