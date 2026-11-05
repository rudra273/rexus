import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, type ApiToken } from '../api'
import { DeployTokensOverview, HistoryButton, useTokenHistory } from './deploy_tokens'
import { ProjectPicker, useVisibleProjects } from './access'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, cx, fmtTime, timeAgo } from '../ui'

const STATUS_TONE = { active: 'green', expired: 'amber', revoked: 'zinc' } as const

export function IntegrationsPage() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [max, setMax] = useState(50)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ token: string; meta: ApiToken } | null>(null)
  const history = useTokenHistory(tokens)
  const [tab, setTab] = useState<'tokens' | 'docs'>(window.location.hash === '#docs' ? 'docs' : 'tokens')
  const switchTab = (t: 'tokens' | 'docs') => {
    setTab(t)
    window.history.replaceState(null, '', t === 'docs' ? '#docs' : window.location.pathname)
  }

  const load = useCallback(() => {
    api<{ tokens: ApiToken[]; max: number }>('/api/tokens')
      .then((r) => {
        setTokens(r.tokens)
        setMax(r.max)
      })
      .catch((e) => setError(e.message))
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke “${t.name}”? Any tool using it stops working immediately. This can't be undone.`)) return
    setError(null)
    try {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (error && !tokens) return <ErrorBox error={error} />
  if (!tokens) return <Spinner />
  const active = tokens.filter((t) => t.status === 'active').length

  return (
    <>
      <PageHeader
        title="API & integrations"
        subtitle="Tokens for the tools and apps that talk to Rexus — and the docs for using them."
      />
      <div className="mb-6 flex gap-1 border-b border-zinc-800">
        {([['tokens', 'Tokens'], ['docs', 'Docs']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => switchTab(id)}
            className={cx(
              '-mb-px border-b-2 px-4 py-2 text-sm',
              tab === id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />

      {tab === 'docs' ? (
        <ApiDocs />
      ) : (
      <>
      <section className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-medium text-zinc-200">API tokens</h2>
          <div className="flex items-center gap-2">
            <HistoryButton past={history.past} shown={history.shown} onToggle={history.toggle} />
            <Button variant="secondary" onClick={() => setCreating(true)} disabled={active >= max}>Create API token</Button>
          </div>
        </div>
        <p className="mb-3 max-w-3xl text-sm text-zinc-500">
          For your CRM, CI or a status board: read project status, health and secret names by project key.
        </p>
        {(history.visible ?? []).length === 0 ? (
          <Empty title={tokens.length > 0 ? 'No active tokens' : 'No tokens yet'}>
            {tokens.length > 0 ? 'Revoked and expired tokens are under History.' : <>Create a token, then call the API with <code>Authorization: Bearer &lt;token&gt;</code>. See the Docs tab.</>}
          </Empty>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Token</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Projects</th>
                  <th className="px-4 py-2.5 font-medium">Last used</th>
                  <th className="px-4 py-2.5 font-medium">Expires</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {(history.visible ?? []).map((t) => (
                  <tr key={t.id} className={cx('align-top', t.status !== 'active' && 'opacity-60')}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-zinc-100">{t.name}</div>
                      <div className="text-xs text-zinc-500">
                        <span className="mono">{t.prefix}…</span> · created {timeAgo(t.created_at)}{t.created_by ? ` by ${t.created_by}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><Badge tone={t.role === 'contributor' ? 'amber' : 'sky'}>{t.role}</Badge></td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400" title={t.allowed_projects.join(', ')}>
                      {t.all_projects ? 'all they can see' : t.allowed_projects.length ? t.allowed_projects.slice(0, 2).join(', ') + (t.allowed_projects.length > 2 ? ` +${t.allowed_projects.length - 2}` : '') : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400" title={fmtTime(t.last_used_at)}>
                      {t.last_used_at ? (
                        <>
                          {timeAgo(t.last_used_at)}
                          {t.last_used_ip && <div className="text-xs text-zinc-500 mono">{t.last_used_ip}</div>}
                        </>
                      ) : (
                        <span className="text-zinc-600">never used</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400">{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'never'}</td>
                    <td className="px-4 py-2.5"><Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge></td>
                    <td className="px-4 py-2.5 text-right">
                      {t.status === 'active' && (
                        <button className="text-xs text-zinc-400 hover:text-red-400" onClick={() => revoke(t)}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          Tokens are shown once, when you create them — only a hash is stored. Every use shows up in the audit log under the token’s name.
        </p>
      </section>

      <DeployTokensOverview canRevoke />
      </>
      )}

      {creating && (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false)
            setCreated(r)
            load()
          }}
        />
      )}
      {created && <TokenShownModal token={created.token} meta={created.meta} onClose={() => setCreated(null)} />}
    </>
  )
}

// ───────────────────────── create / show a token ─────────────────────────

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { token: string; meta: ApiToken }) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<'viewer' | 'contributor'>('viewer')
  const [expiry, setExpiry] = useState('90')
  const projects = useVisibleProjects()
  const [limit, setLimit] = useState(false)
  const [keys, setKeys] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (limit && keys.length === 0) {
      setError('Choose at least one project, or switch to “All projects I can see”.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ token: string; meta: ApiToken }>('/api/tokens', {
        method: 'POST',
        body: { name, role, expires_in_days: expiry === 'never' ? null : Number(expiry), projects: limit ? keys : undefined },
      })
      onCreated(r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create API token" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="What will use it — e.g. “CRM status sync”. Shown in the audit log.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </Field>
        <Field
          label="Role"
          hint={
            role === 'viewer'
              ? 'Read-only: project status, health checks, job status and secret names/expiry. No secret values.'
              : 'Everything a viewer can read, plus secret values (read with a separate call, audited every time). Use sparingly.'
          }
        >
          <Select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'contributor')}>
            <option value="viewer">Viewer (recommended)</option>
            <option value="contributor">Contributor (can read secret values)</option>
          </Select>
        </Field>
        <Field label="Projects" hint="A token never sees more than you can see yourself.">
          <div className="space-y-2">
            <Select value={limit ? 'some' : 'all'} onChange={(e) => setLimit(e.target.value === 'some')}>
              <option value="all">All projects I can see</option>
              <option value="some">Only selected projects</option>
            </Select>
            {limit && (!projects ? <Spinner /> : <ProjectPicker projects={projects} value={keys} onChange={setKeys} />)}
          </div>
        </Field>
        <Field label="Expires" hint="Short-lived tokens limit the damage if one leaks.">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
            <option value="never">Never</option>
          </Select>
        </Field>
        <p className="text-xs text-zinc-500">Tokens can never manage users, backups, alerts or other tokens.</p>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create token'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

function TokenShownModal({ token, meta, onClose }: { token: string; meta: ApiToken; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const base = window.location.origin
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      // Clipboard needs HTTPS or localhost; the token is selectable below.
    }
  }
  return (
    <Modal title={`Token “${meta.name}” created`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Copy it now — <b>it won’t be shown again.</b> If you lose it, revoke it and create a new one.
        </div>
        <div className="flex gap-2">
          <Input readOnly value={token} className="mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <div>
          <div className="mb-1 text-xs text-zinc-500">Try it:</div>
          <pre className="overflow-x-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300 mono">{`curl -H "Authorization: Bearer ${token}" \\\n  ${base}/api/v1/health`}</pre>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

// ───────────────────────── docs ─────────────────────────

function Code({ children }: { children: ReactNode }) {
  return <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300 mono">{children}</pre>
}

interface Endpoint {
  method: 'GET' | 'POST'
  path: string
  role: string
  summary: string
  example?: string
}

const ENDPOINTS: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/v1/health',
    role: 'any token',
    summary: 'Check that your token works. Returns the token’s name and role (and, for a deploy token, its project, environment and service).',
    example: `{ "ok": true, "token": { "name": "CRM status sync", "role": "viewer", "expires_at": null }, "time": "2026-11-05T12:00:00Z" }`,
  },
  {
    method: 'GET',
    path: '/api/v1/env',
    role: 'deploy token only',
    summary: 'The current value of every secret in the deploy token’s scope (its project, environment and service) — nothing else. Returns a .env file; add ?format=json for JSON. Call it once when your app starts. Every call is audited. API tokens get 403 here, and deploy tokens get 403 everywhere except this and /api/v1/health.',
    example: `curl -fsS -H "Authorization: Bearer $REXUS_TOKEN" $REXUS_URL/api/v1/env > .env

DATABASE_URL="postgres://…"
STRIPE_KEY="sk_live_…"`,
  },
  {
    method: 'GET',
    path: '/api/v1/projects',
    role: 'API token',
    summary: 'Every project with its overall status.',
    example: `{ "projects": [ { "key": "acme-web", "name": "Acme Website", "status": "down", "check_count": 3, "job_count": 2, "failing_jobs": 0, ... } ] }`,
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/status',
    role: 'API token',
    summary: 'The compact answer for a CRM: is this project OK? Status is up, degraded, down, unknown (not checked yet) or none (no checks). Add ?service=<key> for one service, ?service=- for the project’s own resources, ?environment=<name> for one environment.',
    example: `{
  "key": "acme-web", "name": "Acme Website",
  "status": "degraded",
  "checks_total": 3, "checks_up": 2, "checks_degraded": 1, "checks_down": 0, "checks_unknown": 0, "checks_paused": 0,
  "jobs_total": 2, "jobs_failing": 0,
  "secrets_expiring_30d": 1,
  "generated_at": "2026-11-05T12:00:00Z"
}`,
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}',
    role: 'API token',
    summary: 'Everything about one project: its services, checks, jobs, and secrets expiring in 30 days.',
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/services',
    role: 'API token',
    summary: 'The project’s services (optional groups such as frontend or backend), each with its own status and counts.',
    example: `{ "services": [ { "key": "backend", "name": "Backend API", "status": "up", "check_count": 2, "job_count": 1, "failing_jobs": 0, "secret_count": 6, ... } ] }`,
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/checks',
    role: 'API token',
    summary: 'Health checks: service, environment, status, since when, last response time and code, 24-hour uptime, SSL expiry. URLs are returned without their query string. Filter with ?service= and ?environment= (use - for "none").',
    example: `{ "checks": [ { "id": "…", "name": "Website", "url": "https://acme.com/health", "status": "up", "last_response_ms": 84, "uptime_24h": 99.93, "ssl_expires_at": "2027-01-10T00:00:00Z", ... } ] }`,
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/jobs',
    role: 'API token',
    summary: 'Cron jobs: service, environment, schedule, whether enabled, last result and time. Their URLs, headers and bodies are never returned. Filter with ?service= and ?environment=.',
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/secrets',
    role: 'API token',
    summary: 'Secret names, service, environment, tags, expiry date and days left. Never values. Contributor tokens also get notes and custom fields. Filter with ?service= and ?environment=.',
  },
  {
    method: 'GET',
    path: '/api/v1/secrets/expiring?days=30',
    role: 'API token',
    summary: 'Secrets across all projects that expire within the given number of days (default 30), including ones already expired.',
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/secrets/{environment}/{name}',
    role: 'API token',
    summary: 'Metadata of one secret that belongs to the project itself, e.g. /api/v1/projects/acme-web/secrets/prod/STRIPE_KEY. A service’s secret with the same name is never returned here.',
  },
  {
    method: 'GET',
    path: '/api/v1/projects/{key}/services/{service}/secrets/{environment}/{name}',
    role: 'API token',
    summary: 'Metadata of one secret of a service, e.g. /api/v1/projects/acme-web/services/backend/secrets/prod/DATABASE_URL.',
  },
  {
    method: 'POST',
    path: '/api/v1/projects/{key}/secrets/{environment}/{name}/reveal',
    role: 'contributor API token only',
    summary: 'The secret’s current value. A viewer token gets 403. Every call is written to the audit log under the token’s name.',
    example: `{ "project": "acme-web", "service": null, "environment": "prod", "name": "STRIPE_KEY", "version": 3, "value": "sk_live_…" }`,
  },
  {
    method: 'POST',
    path: '/api/v1/projects/{key}/services/{service}/secrets/{environment}/{name}/reveal',
    role: 'contributor API token only',
    summary: 'The current value of a service’s secret. Audited like the call above.',
  },
]

/** Which kind of token each endpoint is for — shown as headings in the docs. */
function endpointGroup(e: Endpoint): 'any' | 'apps' | 'tools' {
  if (e.path === '/api/v1/health') return 'any'
  if (e.path === '/api/v1/env') return 'apps'
  return 'tools'
}

const GROUPS: { id: 'any' | 'apps' | 'tools'; title: string; blurb: string }[] = [
  { id: 'any', title: 'Any token', blurb: 'Works with both kinds of token.' },
  { id: 'apps', title: 'For your apps — deploy token', blurb: 'An app fetches its own environment variables when it starts. Create the token on the project’s page.' },
  { id: 'tools', title: 'For other tools — API token', blurb: 'Read-only status and metadata, for a CRM, CI or a status board. Create the token on the Tokens tab.' },
]

function ApiDocs() {
  const base = window.location.origin
  return (
    <section className="mt-10">
      <h2 className="mb-1 font-medium text-zinc-200">API documentation</h2>
      <p className="mb-4 text-sm text-zinc-500">A small, read-only JSON API. Base URL: <code>{base}</code></p>

      <Card className="mb-4 space-y-3 p-4 text-sm text-zinc-400">
        <div className="font-medium text-zinc-200">Quick start</div>
        <p>
          Send your token in the <code>Authorization</code> header — a browser login does not work here. There are two kinds of token:
          <b className="text-zinc-300"> API tokens</b> (Tokens tab) read status and metadata for other tools, and
          <b className="text-zinc-300"> deploy tokens</b> (a project’s page) let one app fetch its own environment variables at startup.
        </p>
        <Code>{`export REXUS_URL=${base}
export REXUS_TOKEN=rxt_…

# is this client's project OK?
curl -s -H "Authorization: Bearer $REXUS_TOKEN" \\
  $REXUS_URL/api/v1/projects/acme-web/status`}</Code>
        <p>
          Your CRM stores the <b className="text-zinc-200">project key</b> (e.g. <code>acme-web</code>) against each client and calls
          <code> /api/v1/projects/&lt;key&gt;/status</code>. If you rename a project’s key in Rexus, the old key stops working — update the CRM.
        </p>
      </Card>

      {GROUPS.map((g) => (
        <div key={g.id} className="mb-6">
          <h3 className="font-medium text-zinc-200">{g.title}</h3>
          <p className="mb-2 text-sm text-zinc-500">{g.blurb}</p>
          <div className="space-y-2">
            {ENDPOINTS.filter((e) => endpointGroup(e) === g.id).map((e) => (
              <Card key={e.method + e.path} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.method === 'GET' ? 'sky' : 'amber'}>{e.method}</Badge>
                  <code className="break-all text-sm text-zinc-100">{e.path}</code>
                  <span className="ml-auto text-xs text-zinc-500">{e.role}</span>
                </div>
                <p className="mt-2 text-sm text-zinc-400">{e.summary}</p>
                {e.example && <div className="mt-2"><Code>{e.example}</Code></div>}
              </Card>
            ))}
          </div>
        </div>
      ))}

      <Card className="mt-4 space-y-3 p-4 text-sm text-zinc-400">
        <div className="font-medium text-zinc-200">Good to know</div>
        <ul className="list-disc space-y-1.5 pl-5">
          <li><b className="text-zinc-300">Roles.</b> An <i>API token</i> is a viewer (status, names and expiry dates) or a contributor (can also read secret values). A <i>deploy token</i> can only read one environment’s secrets through <code>/api/v1/env</code> and is refused everywhere else. No token is ever admin or owner, and none can change anything.</li>
          <li><b className="text-zinc-300">Rate limit.</b> 300 requests per minute per token. Above that you get <code>429</code> with a <code>Retry-After</code> header. Status data refreshes every minute or so, so polling more often is pointless.</li>
          <li><b className="text-zinc-300">Errors.</b> JSON like <code>{`{ "error": "…" }`}</code>. <code>401</code> missing, wrong, expired or revoked token (20 wrong tokens from one address lock it out for 15 minutes) · <code>403</code> not allowed for this role, or Rexus is in lockdown · <code>404</code> unknown project or secret.</li>
          <li><b className="text-zinc-300">Never returned.</b> Job URLs, headers and bodies, credentials in monitored URLs, notes and custom fields (viewer tokens), and secret values (except the reveal call).</li>
          <li><b className="text-zinc-300">Audit.</b> Reading a secret value is logged every time; other use is logged at most every 10 minutes per token, with a request count.</li>
          <li><b className="text-zinc-300">Access rules still apply.</b> The IP allowlist applies to the API, and lockdown mode switches all tokens off.</li>
        </ul>
      </Card>
    </section>
  )
}
