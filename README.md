# Rexus

A self-hosted control panel for technical teams: projects, scheduled jobs (keepalives, pings), encrypted secrets and health — in one place. One Go binary with the React UI built in.

> Status: **Phase 1** — login + 2FA, owner setup, projects, keepalive/ping jobs with run history. See [plan.md](plan.md) for the full roadmap.

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

## CLI

The same binary is the CLI. With Docker, prefix commands with `docker compose exec rexus`.

| Command | What it does |
|---|---|
| `rexus serve` | Start web UI + API + scheduler |
| `rexus owner create --email you@company.com` | Create the owner (instead of the setup screen) |
| `rexus owner reset` | Lost password or 2FA: set a new password, reset 2FA, log out all owner sessions |
| `rexus migrate` | Run database migrations and exit |
| `rexus keygen` | Generate a `REXUS_MASTER_KEY` |

Whoever can run commands on the server can recover the owner — no secret owner key lives in code or env vars.

## Configuration

Everything is in env vars (or `.env`); see [.env.example](.env.example). Changing a value needs a restart; invalid values stop startup with a clear error. Toggles are shown read-only in **Settings**.

**Keep `REXUS_MASTER_KEY` safe and separate from backups.** It encrypts 2FA secrets, job headers (e.g. API keys) and, from Phase 2, vault secrets.

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
internal/crypto/      AES-256-GCM with the master key, tokens
internal/auth/        Argon2id passwords, TOTP, rate limiting
internal/db/          Postgres pool + embedded SQL migrations
internal/store/       all queries
internal/scheduler/   cron engine (state in DB, restart-safe)
internal/server/      HTTP API + embedded UI
web/                  React + Vite + Tailwind UI (embedded via go:embed)
```

## License

MIT (to be added before the first public release).
