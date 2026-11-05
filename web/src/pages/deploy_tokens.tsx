import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type ApiToken, type Project, type Service } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Select, Spinner, cx, fmtTime, timeAgo } from '../ui'
import { useEnvironments } from './services'

const STATUS_TONE = { active: 'green', expired: 'amber', revoked: 'zinc' } as const

/** Where a deploy token can read from, e.g. “prod · backend”. */
function ScopeLabel({ t }: { t: ApiToken }) {
  return (
    <span className="mono text-xs text-zinc-300">
      {t.environment}
      <span className="text-zinc-600"> · </span>
      {t.service ?? <span className="text-zinc-500">project itself</span>}
    </span>
  )
}

export function DeployTokenTable({
  tokens,
  showProject,
  canRevoke,
  onRevoke,
}: {
  tokens: ApiToken[]
  showProject: boolean
  canRevoke: boolean
  onRevoke: (t: ApiToken) => void
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
                {showProject && <div className="mono text-xs text-zinc-100">{t.project}</div>}
                <ScopeLabel t={t} />
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
              <td className="px-4 py-2.5 text-right">
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
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    const q = projectKey ? `?project=${encodeURIComponent(projectKey)}` : ''
    api<{ tokens: ApiToken[]; max: number }>(`/api/deploy-tokens${q}`)
      .then((r) => {
        setTokens(r.tokens)
        setMax(r.max)
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
  return { tokens, max, error, reload: load, revoke }
}

/** The "Deploy tokens" section of a project page. */
export function ProjectDeployTokens({ project, services, writable }: { project: Project; services: Service[]; writable: boolean }) {
  const { tokens, max, error, reload, revoke } = useDeployTokens(project.key)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ token: string; meta: ApiToken; url: string } | null>(null)
  const active = tokens?.filter((t) => t.status === 'active').length ?? 0

  return (
    <section className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Deploy tokens</h2>
        {writable && (
          <Button variant="secondary" onClick={() => setCreating(true)} disabled={active >= max}>Create deploy token</Button>
        )}
      </div>
      <p className="mb-3 max-w-3xl text-sm text-zinc-500">
        Lets one app load its environment variables from this project when it starts. A token reads one environment
        (and optionally one service) — nothing else.
      </p>
      <ErrorBox error={error} />
      {!tokens ? (
        <Spinner />
      ) : tokens.length === 0 ? (
        <Empty title="No deploy tokens">Create one for each app you deploy, then fetch its env at startup.</Empty>
      ) : (
        <DeployTokenTable tokens={tokens} showProject={false} canRevoke={writable} onRevoke={revoke} />
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
      {created && <DeployTokenShownModal {...created} onClose={() => setCreated(null)} />}
    </section>
  )
}

function CreateDeployTokenModal({
  project,
  services,
  onClose,
  onCreated,
}: {
  project: Project
  services: Service[]
  onClose: () => void
  onCreated: (r: { token: string; meta: ApiToken; url: string }) => void
}) {
  const envs = useEnvironments(project.key)
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
        body: { name, project: project.key, environment: env, service, expires_in_days: expiry === 'never' ? null : Number(expiry) },
      })
      onCreated(r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Create deploy token — ${project.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="Which app uses it — e.g. “vidyakalp-prod-backend”. Shown in the audit log.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
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
          <Button type="submit" disabled={busy || !env}>{busy ? 'Creating…' : 'Create token'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

function CopyBlock({ text, label }: { text: string; label: string }) {
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
      <pre className="overflow-x-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300 mono">{text}</pre>
    </div>
  )
}

function DeployTokenShownModal({ token, meta, url, onClose }: { token: string; meta: ApiToken; url: string; onClose: () => void }) {
  return (
    <Modal title={`Deploy token “${meta.name}” created`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Copy it now — <b>it won’t be shown again.</b> If you lose it, revoke it and create a new one.
        </div>
        <CopyBlock label="1. Set these two variables in your deployment platform" text={`REXUS_URL=${url}\nREXUS_TOKEN=${token}`} />
        <CopyBlock
          label="2. Make your start command load the env first"
          text={`curl -fsS -H "Authorization: Bearer $REXUS_TOKEN" "$REXUS_URL/api/v1/env" > .env && node server.js`}
        />
        <p className="text-xs text-zinc-500">
          <code>-f</code> makes the start fail if Rexus can't be reached, instead of running without secrets. Fetch at <b>startup</b>, not
          during the build — build-time values can end up inside your image or frontend bundle. Add <code>?format=json</code> for JSON.
        </p>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

/** The deploy-token overview on the API page (all projects). */
export function DeployTokensOverview({ canRevoke }: { canRevoke: boolean }) {
  const { tokens, error, revoke } = useDeployTokens()
  return (
    <section className="mt-10">
      <h2 className="mb-1 font-medium text-zinc-200">Deploy tokens</h2>
      <p className="mb-3 max-w-3xl text-sm text-zinc-500">
        Per-app tokens that load a project's environment variables at startup. Create them on the project's page; revoke any here.
      </p>
      <ErrorBox error={error} />
      {!tokens ? (
        <Spinner />
      ) : tokens.length === 0 ? (
        <Empty title="No deploy tokens yet">Open a project and create one under “Deploy tokens”.</Empty>
      ) : (
        <DeployTokenTable tokens={tokens} showProject canRevoke={canRevoke} onRevoke={revoke} />
      )}
    </section>
  )
}
