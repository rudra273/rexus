import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, isAdmin, type Environment, type Project, type Scoped, type Service, type ServiceFilter } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, Select, StatusDot, Textarea, WebsiteLink, cx, hostOf } from '../ui'

// Services are optional groups inside a project (frontend, backend, worker…).
// They organize secrets, jobs and checks; they are not an access boundary.

const SERVICE_KEY_HINT = '2–40 characters: lowercase letters, numbers and dashes. Used in API paths.'

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** Loads a project's services; `reload` refreshes counts after a change. */
export function useServices(projectKey: string | null | undefined) {
  const [services, setServices] = useState<Service[] | null>(null)
  const reload = useCallback(async () => {
    if (!projectKey) return setServices([])
    try {
      const r = await api<{ services: Service[] }>(`/api/projects/${encodeURIComponent(projectKey)}/services`)
      setServices(r.services)
    } catch {
      setServices([])
    }
  }, [projectKey])
  useEffect(() => {
    reload()
  }, [reload])
  return { services, reload }
}

/** Loads a project's environments (for job/check scope selectors). */
export function useEnvironments(projectKey: string | null | undefined, enabled = true) {
  const [envs, setEnvs] = useState<Environment[]>([])
  useEffect(() => {
    if (!projectKey || !enabled) return setEnvs([])
    api<{ environments: Environment[] }>(`/api/projects/${encodeURIComponent(projectKey)}/environments`)
      .then((r) => setEnvs(r.environments))
      .catch(() => setEnvs([]))
  }, [projectKey, enabled])
  return envs
}

/** Query-string fragment for a service filter ('' = all). */
export function serviceQuery(filter: ServiceFilter, prefix: '?' | '&' = '&') {
  return filter ? `${prefix}service=${encodeURIComponent(filter)}` : ''
}

/** Small label naming a resource's service (nothing for "the project directly"). */
export function ServiceBadge({ r }: { r: Pick<Scoped, 'service_key'> }) {
  if (!r.service_key) return null
  return <Badge tone="sky">{r.service_key}</Badge>
}

export function EnvBadge({ env }: { env: string | null | undefined }) {
  if (!env) return null
  return <Badge>{env}</Badge>
}

/** "Project directly" + each service. value '' = the project directly. */
export function ServiceSelect({ services, value, onChange, disabled }: { services: Service[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Project directly</option>
      {services.map((s) => (
        <option key={s.id} value={s.id}>{s.name} ({s.key})</option>
      ))}
    </Select>
  )
}

export function EnvironmentSelect({ envs, value, onChange }: { envs: Environment[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No environment</option>
      {envs.map((e) => (
        <option key={e.id} value={e.id}>{e.name}</option>
      ))}
    </Select>
  )
}

/** Filter chips for a project page: All · Project directly · each service. */
export function ScopeBar({ services, value, onChange }: { services: Service[]; value: ServiceFilter; onChange: (v: ServiceFilter) => void }) {
  const chip = (v: ServiceFilter, label: string, key?: string) => (
    <button
      key={key ?? v}
      onClick={() => onChange(v)}
      className={cx(
        'rounded-md border px-3 py-1.5 text-sm',
        v === value ? 'border-emerald-600 bg-emerald-950/40 text-emerald-200' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200',
      )}
    >
      {label}
    </button>
  )
  return (
    <div className="mt-6 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-zinc-500">Show</span>
      {chip('', 'All services')}
      {chip('-', 'Project directly')}
      {services.map((s) => chip(s.id, s.name))}
    </div>
  )
}

// ───────────────────────── project page: services list ─────────────────────────

export function ProjectServices({ project, services, onChanged }: { project: Project; services: Service[]; onChanged: () => void }) {
  const { user } = useAuth()
  const writable = !!user && isAdmin(user.role)
  const [form, setForm] = useState<{ existing?: Service } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = async (s: Service) => {
    if (!confirm(`Delete the service "${s.name}"?`)) return
    setError(null)
    try {
      await api(`/api/services/${s.id}`, { method: 'DELETE' })
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (services.length === 0 && !writable) return null

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Services</h2>
        {writable && <Button variant="secondary" onClick={() => setForm({})}>Add service</Button>}
      </div>
      <ErrorBox error={error} />
      {services.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Optional. Split a larger project into parts — e.g. <span className="mono">frontend</span>, <span className="mono">backend</span>, <span className="mono">worker</span> — each with its own secrets, jobs and checks. Simple projects don't need any.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((s) => (
            <Card key={s.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot status={s.health_status !== 'none' ? s.health_status : s.failing_jobs > 0 ? 'failed' : 'none'} />
                    <span className="truncate font-medium text-zinc-100">{s.name}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 mono">{s.key}</div>
                  {s.website_url && <WebsiteLink url={s.website_url} label={hostOf(s.website_url)} className="mt-1 max-w-full truncate text-xs" />}
                  {s.repository_url && (
                    <div className="mt-0.5 truncate text-xs text-zinc-500 mono" title={s.repository_url}>
                      {s.repository_url}{s.root_directory ? ` · ${s.root_directory}` : ''}
                    </div>
                  )}
                  {!s.repository_url && s.root_directory && <div className="mt-0.5 truncate text-xs text-zinc-500 mono">{s.root_directory}</div>}
                  <div className="mt-1.5 text-xs text-zinc-400">
                    {s.check_count} check{s.check_count === 1 ? '' : 's'} · {s.job_count} job{s.job_count === 1 ? '' : 's'}
                    {s.failing_jobs > 0 && <span className="text-red-400"> ({s.failing_jobs} failing)</span>} · {s.secret_count} secret{s.secret_count === 1 ? '' : 's'}
                  </div>
                </div>
                {writable && (
                  <span className="flex shrink-0 gap-3 text-xs text-zinc-500">
                    <button onClick={() => setForm({ existing: s })} className="hover:text-zinc-200">Edit</button>
                    <button onClick={() => remove(s)} className="hover:text-red-400">Delete</button>
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {form && (
        <ServiceForm
          project={project}
          existing={form.existing}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            onChanged()
          }}
        />
      )}
    </section>
  )
}

function ServiceForm({ project, existing, onClose, onSaved }: { project: Project; existing?: Service; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [key, setKey] = useState(existing?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(!!existing)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [repo, setRepo] = useState(existing?.repository_url ?? '')
  const [website, setWebsite] = useState(existing?.website_url ?? '')
  const [root, setRoot] = useState(existing?.root_directory ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const renaming = !!existing && key !== existing.key

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (renaming && !confirm(`Change the service key "${existing!.key}" → "${key}"?\n\nAPI paths that use the old key stop working.`)) return
    setBusy(true)
    setError(null)
    const body = { name, key, description, repository_url: repo, root_directory: root, website_url: website }
    try {
      if (existing) await api(`/api/services/${existing.id}`, { method: 'PATCH', body })
      else await api(`/api/projects/${encodeURIComponent(project.key)}/services`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add service'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!keyTouched) setKey(slugify(e.target.value))
              }}
              placeholder="Backend API"
              autoFocus
              required
            />
          </Field>
          <Field label="Service key" hint={SERVICE_KEY_HINT}>
            <Input
              value={key}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value.toLowerCase())
              }}
              className="mono"
              placeholder="backend"
              required
            />
          </Field>
        </div>
        <Field label="Website (optional)" hint="Where this service is reachable — shows as a quick link on the project page.">
          <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} className="mono" placeholder="https://app.example.com" />
        </Field>
        <Field label="Description (optional)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Repository (optional)" hint="For reference only — Rexus doesn't access it.">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} className="mono" placeholder="https://github.com/acme/app" />
          </Field>
          <Field label="Root directory (optional)" hint="In a monorepo">
            <Input value={root} onChange={(e) => setRoot(e.target.value)} className="mono" placeholder="apps/api" />
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Add service'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}
