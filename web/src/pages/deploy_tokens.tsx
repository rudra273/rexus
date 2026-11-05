import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type ApiToken, type Project, type Service } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Select, Spinner, cx, fmtTime, timeAgo } from '../ui'
import { useEnvironments, useServices } from './services'

const STATUS_TONE = { active: 'green', expired: 'amber', revoked: 'zinc' } as const

/** Active tokens show by default; revoked and expired ones live behind a History button. */
export function useTokenHistory<T extends { status: string }>(tokens: T[] | null) {
  const [shown, setShown] = useState(false)
  const past = tokens?.filter((t) => t.status !== 'active').length ?? 0
  const visible = tokens ? (shown ? tokens : tokens.filter((t) => t.status === 'active')) : null
  return { visible, past, shown, toggle: () => setShown((v) => !v) }
}

export function HistoryButton({ past, shown, onToggle }: { past: number; shown: boolean; onToggle: () => void }) {
  if (past === 0) return null
  return (
    <Button variant="ghost" onClick={onToggle}>
      {shown ? 'Hide history' : `History (${past})`}
    </Button>
  )
}

/** Where a deploy token can read from, on one line: [project] environment service. */
function ScopeLabel({ t, showProject }: { t: ApiToken; showProject: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showProject && <span className="mono text-xs text-zinc-100">{t.project}</span>}
      <Badge>{t.environment}</Badge>
      {t.service ? <Badge tone="sky">{t.service}</Badge> : <span className="text-xs text-zinc-500">project itself</span>}
    </div>
  )
}

export function DeployTokenTable({
  tokens,
  showProject,
  canRevoke,
  onRevoke,
  onConnect,
}: {
  tokens: ApiToken[]
  showProject: boolean
  canRevoke: boolean
  onRevoke: (t: ApiToken) => void
  onConnect: (t: ApiToken) => void
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Token</th>
            <th className="px-4 py-2.5 font-medium">{showProject ? 'Project · environment · service' : 'Environment · service'}</th>
            <th className="px-4 py-2.5 font-medium">Last used</th>
            <th className="px-4 py-2.5 font-medium">Expires</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {tokens.map((t) => (
            <tr key={t.id} className={cx('align-top', t.status !== 'active' && 'opacity-60')}>
              <td className="px-4 py-2.5">
                <div className="font-medium text-zinc-100">{t.name}</div>
                <div className="text-xs text-zinc-500">
                  <span className="mono">{t.prefix}…</span> · created {timeAgo(t.created_at)}
                  {t.created_by ? ` by ${t.created_by}` : ''}
                </div>
              </td>
              <td className="px-4 py-2.5">
                <ScopeLabel t={t} showProject={showProject} />
              </td>
              <td className="px-4 py-2.5 text-zinc-400" title={fmtTime(t.last_used_at)}>
                {t.last_used_at ? (
                  <>
                    {timeAgo(t.last_used_at)}
                    {t.last_used_ip && <div className="mono text-xs text-zinc-500">{t.last_used_ip}</div>}
                  </>
                ) : (
                  <span className="text-zinc-600">never used</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-zinc-400">{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'never'}</td>
              <td className="px-4 py-2.5"><Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge></td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right">
                {t.status === 'active' && (
                  <button className="mr-3 text-xs text-zinc-400 hover:text-emerald-400" onClick={() => onConnect(t)}>Connect</button>
                )}
                {canRevoke && t.status === 'active' && (
                  <button className="text-xs text-zinc-400 hover:text-red-400" onClick={() => onRevoke(t)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/** Loads deploy tokens (all projects, or one) and handles revoking. */
export function useDeployTokens(projectKey?: string) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [max, setMax] = useState(100)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    const q = projectKey ? `?project=${encodeURIComponent(projectKey)}` : ''
    api<{ tokens: ApiToken[]; max: number; url: string }>(`/api/deploy-tokens${q}`)
      .then((r) => {
        setTokens(r.tokens)
        setMax(r.max)
        setUrl(r.url)
      })
      .catch((e) => setError(e.message))
  }, [projectKey])
  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke “${t.name}”? The app using it can't fetch its env on the next start. This can't be undone.`)) return
    setError(null)
    try {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return { tokens, max, url, error, reload: load, revoke }
}

/** The "Deploy tokens" section of a project page. */
export function ProjectDeployTokens({ project, services, writable }: { project: Project; services: Service[]; writable: boolean }) {
  const { tokens, max, url, error, reload, revoke } = useDeployTokens(project.key)
  const [connecting, setConnecting] = useState<ApiToken | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ token: string; meta: ApiToken; url: string } | null>(null)
  const active = tokens?.filter((t) => t.status === 'active').length ?? 0
  const history = useTokenHistory(tokens)

  return (
    <section className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Deploy tokens</h2>
        <div className="flex items-center gap-2">
          <HistoryButton past={history.past} shown={history.shown} onToggle={history.toggle} />
          {writable && (
            <Button variant="secondary" onClick={() => setCreating(true)} disabled={active >= max}>Create deploy token</Button>
          )}
        </div>
      </div>
      <p className="mb-3 max-w-3xl text-sm text-zinc-500">
        Lets one app load its environment variables from this project when it starts. A token reads one environment
        (and optionally one service) — nothing else.
      </p>
      <ErrorBox error={error} />
      {!history.visible ? (
        <Spinner />
      ) : history.visible.length === 0 ? (
        <Empty title={tokens && tokens.length > 0 ? 'No active deploy tokens' : 'No deploy tokens'}>
          {tokens && tokens.length > 0 ? 'Revoked and expired tokens are under History.' : 'Create one for each app you deploy, then fetch its env at startup.'}
        </Empty>
      ) : (
        <DeployTokenTable tokens={history.visible} showProject={false} canRevoke={writable} onRevoke={revoke} onConnect={setConnecting} />
      )}

      {creating && (
        <CreateDeployTokenModal
          project={project}
          services={services}
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false)
            setCreated(r)
            reload()
          }}
        />
      )}
      {created && <ConnectModal {...created} onClose={() => setCreated(null)} />}
      {creating && (
        <CreateDeployTokenModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false)
            setCreated(r)
            reload()
          }}
        />
      )}
      {created && <ConnectModal {...created} onClose={() => setCreated(null)} />}
      {connecting && <ConnectModal meta={connecting} url={url} onClose={() => setConnecting(null)} />}
    </section>
  )
}

function CreateDeployTokenModal({
  project,
  services: fixedServices,
  onClose,
  onCreated,
}: {
  /** Opened from a project's page: the project is fixed. Without it (API page) the user picks one. */
  project?: Project
  services?: Service[]
  onClose: () => void
  onCreated: (r: { token: string; meta: ApiToken; url: string }) => void
}) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [picked, setPicked] = useState('')
  useEffect(() => {
    if (project) return
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]))
  }, [project])
  const projectKey = project?.key ?? picked
  const envs = useEnvironments(projectKey || null)
  const loaded = useServices(project ? null : projectKey || null).services
  const services = project ? (fixedServices ?? []) : (loaded ?? [])
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('')
  const [service, setService] = useState('')
  const [expiry, setExpiry] = useState('365')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const env = environment || envs.find((e) => e.name === 'prod')?.name || envs[0]?.name || ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ token: string; meta: ApiToken; url: string }>('/api/deploy-tokens', {
        method: 'POST',
        body: { name, project: projectKey, environment: env, service, expires_in_days: expiry === 'never' ? null : Number(expiry) },
      })
      onCreated(r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={project ? `Create deploy token — ${project.name}` : 'Create deploy token'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!project && (
          <Field label="Project" hint="The app's project. The token can read only this project.">
            <Select
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value)
                setEnvironment('')
                setService('')
              }}
              autoFocus
              required
            >
              <option value="">{projects ? 'Choose a project…' : 'Loading…'}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.key}>{p.name} ({p.key})</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name" hint="Which app uses it — e.g. “vidyakalp-prod-backend”. Shown in the audit log.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!!project} required />
        </Field>
        <Field label="Environment" hint="The token reads only this environment's secrets.">
          <Select value={env} onChange={(e) => setEnvironment(e.target.value)} required>
            {envs.map((x) => (
              <option key={x.id} value={x.name}>{x.name}</option>
            ))}
          </Select>
        </Field>
        {services.length > 0 && (
          <Field label="Service" hint="Secrets of that service only. “Project itself” gives the project's own secrets, not any service's.">
            <Select value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">Project itself</option>
              {services.map((s) => (
                <option key={s.id} value={s.key}>{s.name} ({s.key})</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Expires" hint="When it expires, deploys stop getting their env — set a reminder to replace it.">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
            <option value="never">Never</option>
          </Select>
        </Field>
        <p className="text-xs text-zinc-500">It can only read secret values in that scope. It can't see anything else in Rexus.</p>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !env || !projectKey}>{busy ? 'Creating…' : 'Create token'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

function CopyBlock({ text, label, tall }: { text: string; label: string; tall?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard needs HTTPS or localhost; the text is selectable.
    }
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <button type="button" className="text-zinc-400 hover:text-zinc-200" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className={cx('overflow-x-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300 mono', tall && 'max-h-72 overflow-y-auto whitespace-pre-wrap')}>{text}</pre>
    </div>
  )
}

type ConnectTab = 'node' | 'python' | 'shell' | 'ai'

const TABS: { id: ConnectTab; label: string }[] = [
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'shell', label: 'Shell' },
  { id: 'ai', label: 'AI prompt' },
]

// Small, dependency-free snippets. They send a User-Agent because some proxies
// (Cloudflare among them) reject the default one of Python's urllib.
const NODE_SNIPPET = `// rexus-env.js — loads this app's secrets from Rexus once, at startup.
// Needs Node 18+ (built-in fetch). Set REXUS_URL and REXUS_TOKEN in your platform.
async function loadRexusEnv() {
  const res = await fetch(process.env.REXUS_URL + '/api/v1/env?format=json', {
    headers: { Authorization: 'Bearer ' + process.env.REXUS_TOKEN, 'User-Agent': 'rexus-client' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error('Rexus env fetch failed: HTTP ' + res.status) // never start without secrets
  Object.assign(process.env, await res.json())
}
module.exports = { loadRexusEnv }

// In your entry file, before anything reads process.env:
//   const { loadRexusEnv } = require('./rexus-env')
//   loadRexusEnv().then(() => require('./server'))`

const PYTHON_SNIPPET = `# rexus_env.py — loads this app's secrets from Rexus once, at startup.
# Standard library only. Set REXUS_URL and REXUS_TOKEN in your platform.
import json, os, urllib.request

def load_rexus_env():
    req = urllib.request.Request(
        os.environ["REXUS_URL"] + "/api/v1/env?format=json",
        headers={"Authorization": "Bearer " + os.environ["REXUS_TOKEN"], "User-Agent": "rexus-client"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:  # raises on any error: never start without secrets
        os.environ.update(json.load(r))

# At the very top of your entry file, before anything reads os.environ:
#   from rexus_env import load_rexus_env
#   load_rexus_env()`

const SHELL_SNIPPET = `curl -fsS -H "Authorization: Bearer $REXUS_TOKEN" "$REXUS_URL/api/v1/env" > .env && node server.js

# -f makes the start fail if Rexus can't be reached. Swap "node server.js" for your own start command.`

function aiPrompt(meta: ApiToken, url: string) {
  const where = [meta.project, meta.environment, meta.service].filter(Boolean).join(' / ')
  return `Connect this project to Rexus, my self-hosted secrets manager, so the app loads its environment variables when it starts.

Rexus gives me two environment variables. I will set them in my deployment platform, so do not hardcode them or ask me to paste the token here:
- REXUS_URL = ${url}
- REXUS_TOKEN = a deploy token (starts with rxt_)

How the API works:
GET {REXUS_URL}/api/v1/env?format=json
Header: Authorization: Bearer {REXUS_TOKEN}
It returns one flat JSON object of this app's secrets, e.g. {"DATABASE_URL": "...", "STRIPE_KEY": "..."}. This token covers: ${where}. Without ?format=json it returns a .env file instead.

What to do:
1. Work out this project's language and framework.
2. Add a small startup step that calls the endpoint once, before anything reads configuration, and puts the values into the process environment (or the app's config).
3. Fail fast with a clear error if the request fails (network error, non-200, timeout around 10 seconds). Never start the app without its secrets. Send a User-Agent header (some proxies block the default one).
4. Never log or print secret values. Never write them to disk, commit them, or bake them into a Docker image, a build step or a frontend bundle. Fetch at startup (runtime) only, in server-side code.
5. Keep local development working: if REXUS_TOKEN is not set, skip the fetch and use the existing .env or config.
6. Change nothing else. When done, list the environment variables I must set in my deployment platform.`
}

/**
 * The connection info for a deploy token: the two variables, plus Node.js / Python / Shell / AI-prompt
 * snippets. Right after creation `token` is set; later (the Connect button) it isn't, and a placeholder
 * stands in — a token can only be shown once.
 */
function ConnectModal({ token, meta, url, onClose }: { token?: string; meta: ApiToken; url: string; onClose: () => void }) {
  const [tab, setTab] = useState<ConnectTab>('node')
  const body: Record<ConnectTab, { label: string; text: string; note: string }> = {
    node: { label: 'Add this file, and call it once before your app starts', text: NODE_SNIPPET, note: 'Fetch at startup, not during the build — build-time values can end up inside your image or frontend bundle.' },
    python: { label: 'Add this file, and call it once before your app starts', text: PYTHON_SNIPPET, note: 'Fetch at startup, not during the build — build-time values can end up inside your image or frontend bundle.' },
    shell: { label: 'Use as your start command', text: SHELL_SNIPPET, note: 'Add ?format=json for JSON. Works for any language that reads a .env file.' },
    ai: {
      label: 'Paste this into your AI coding assistant (Claude, Cursor, Copilot…)',
      text: aiPrompt(meta, url),
      note: 'The prompt has no secrets in it. Set the two variables above in your deployment platform yourself — don’t paste the token into the chat.',
    },
  }
  const cur = body[tab]
  return (
    <Modal title={token ? `Deploy token “${meta.name}” created` : `Connect “${meta.name}”`} onClose={onClose} wide>
      <div className="space-y-4">
        {token ? (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            Copy it now — <b>it won’t be shown again.</b> If you lose it, revoke it and create a new one.
          </div>
        ) : (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400">
            Reads <span className="mono text-zinc-200">{[meta.project, meta.environment, meta.service].filter(Boolean).join(' / ')}</span>.
            The token itself was shown only once, when it was created. If you no longer have it, revoke this token and create a new one.
          </div>
        )}
        <CopyBlock
          label="1. Set these two variables in your deployment platform"
          text={`REXUS_URL=${url}\nREXUS_TOKEN=${token ?? 'rxt_… (the token you copied when you created it)'}`}
        />
        <div>
          <div className="mb-2 text-xs text-zinc-500">2. Connect your app</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cx(
                  'rounded-md border px-3 py-1 text-xs',
                  tab === t.id ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <CopyBlock label={cur.label} text={cur.text} tall={tab === 'ai'} />
          <p className="mt-2 text-xs text-zinc-500">{cur.note}</p>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

/** The deploy-token overview on the API page (all projects). */
export function DeployTokensOverview({ canRevoke }: { canRevoke: boolean }) {
  const { tokens, max, url, error, reload, revoke } = useDeployTokens()
  const [connecting, setConnecting] = useState<ApiToken | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ token: string; meta: ApiToken; url: string } | null>(null)
  const history = useTokenHistory(tokens)
  const active = tokens?.filter((t) => t.status === 'active').length ?? 0
  return (
    <section className="mt-10">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Deploy tokens</h2>
        <div className="flex items-center gap-2">
          <HistoryButton past={history.past} shown={history.shown} onToggle={history.toggle} />
          {canRevoke && (
            <Button variant="secondary" onClick={() => setCreating(true)} disabled={active >= max}>Create deploy token</Button>
          )}
        </div>
      </div>
      <p className="mb-3 max-w-3xl text-sm text-zinc-500">
        Per-app tokens that load one project's environment variables at startup. You can also create them on a project's page.
      </p>
      <ErrorBox error={error} />
      {!history.visible ? (
        <Spinner />
      ) : history.visible.length === 0 ? (
        <Empty title={tokens && tokens.length > 0 ? 'No active deploy tokens' : 'No deploy tokens yet'}>
          {tokens && tokens.length > 0 ? 'Revoked and expired tokens are under History.' : 'Create one with the button above, then fetch its env at startup.'}
        </Empty>
      ) : (
        <DeployTokenTable tokens={history.visible} showProject canRevoke={canRevoke} onRevoke={revoke} onConnect={setConnecting} />
      )}
      {creating && (
        <CreateDeployTokenModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false)
            setCreated(r)
            reload()
          }}
        />
      )}
      {created && <ConnectModal {...created} onClose={() => setCreated(null)} />}
      {connecting && <ConnectModal meta={connecting} url={url} onClose={() => setConnecting(null)} />}
    </section>
  )
}
