# Rexus

A self-hosted control panel for technical teams: projects, scheduled jobs (keepalives, pings), encrypted secrets and health — in one place. One Go binary with the React UI built in.

> Status: **Phase 3** — login + 2FA, owner setup, projects, keepalive/ping jobs with run history, the encrypted **Vault**, and **team management** (invites, four roles, password resets, audit log). See [plan.md](plan.md) for the full roadmap.

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
| `rexus migrate` | Run database migrations and exit |
| `rexus keygen` | Generate a `REXUS_MASTER_KEY` |

Whoever can run commands on the server can recover the owner — no secret owner key lives in code or env vars.

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
- Invite links expire after 7 days and only work once. Only a hash of each link is stored, so a link can't be shown again — use **New link** to replace it. Rexus doesn't send email yet (that arrives with alerts), so you share the link yourself.
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
