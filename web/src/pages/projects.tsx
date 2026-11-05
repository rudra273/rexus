import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, canWrite, isAdmin, type HealthCheck, type Job, type Project, type Secret } from '../api'
import { useAuth } from '../auth'
import { ActionMenu, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Spinner, StatusDot, Textarea, timeAgo, type DotStatus } from '../ui'
import { JobTable } from './jobs'
import { degradedReason, ProjectChecks } from './health'
import { ExpiryBadge, ProjectVault } from './vault'
import { ProjectServices, ScopeBar, serviceQuery, useServices } from './services'
import { ProjectDeployTokens } from './deploy_tokens'
import { ProjectAccessModal } from './access'

const KEY_HINT = '2–40 characters: lowercase letters, numbers and dashes. Used in URLs and by external tools.'

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

interface AttentionItem {
  id: string
  tone: 'red' | 'amber'
  label: string
  title: string
  sub: string
  to: string
  right?: ReactNode
}

/** "Project" or "Project / service" for attention items. */
function scopeName(r: { project_name: string; service_key: string | null }) {
  return r.service_key ? `${r.project_name} / ${r.service_key}` : r.project_name
}

const SEVERITY: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3, none: 4 }

function projectDot(p: Project): DotStatus {
  if (p.health_status !== 'none') return p.health_status
  if (p.failing_jobs > 0) return 'failed'
  return 'none'
}

export function DashboardPage() {
  const { user, meta } = useAuth()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [checks, setChecks] = useState<HealthCheck[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [expiring, setExpiring] = useState<Secret[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message))
    api<{ checks: HealthCheck[] }>('/api/checks').then((r) => setChecks(r.checks)).catch(() => {})
    if (meta?.modules.scheduler) {
      api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => {})
    }
    if (meta?.modules.vault) {
      api<{ secrets: Secret[] }>('/api/secrets?expiring=30').then((r) => setExpiring(r.secrets)).catch(() => {})
    }
  }, [meta])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <ErrorBox error={error} persistent />
  if (!projects) return <Spinner />

  const active = checks.filter((c) => c.enabled)
  const down = active.filter((c) => c.status === 'down')
  const degraded = active.filter((c) => c.status === 'degraded')
  const failingJobs = jobs.filter((j) => j.enabled && j.last_status === 'failed')

  const items: AttentionItem[] = [
    ...down.map((c): AttentionItem => ({
      id: `d${c.id}`, tone: 'red', label: 'Down', title: c.name, to: `/checks/${c.id}`,
      sub: `${scopeName(c)}${c.last_error ? ` · ${c.last_error}` : ''}${c.status_since ? ` · since ${timeAgo(c.status_since)}` : ''}`,
    })),
    ...degraded.map((c): AttentionItem => ({
      id: `g${c.id}`, tone: 'amber', label: 'Degraded', title: c.name, to: `/checks/${c.id}`,
      sub: `${scopeName(c)} · ${degradedReason(c)}`,
    })),
    ...failingJobs.map((j): AttentionItem => ({
      id: `j${j.id}`, tone: 'red', label: 'Job failed', title: j.name, to: `/jobs/${j.id}`,
      sub: `${scopeName(j)}${j.last_run_at ? ` · last run ${timeAgo(j.last_run_at)}` : ''}`,
    })),
    ...expiring.map((s): AttentionItem => ({
      id: `s${s.id}`, tone: (s.days_left ?? 0) <= 7 ? 'red' : 'amber', label: 'Key expiring', title: s.name,
      to: `/projects/${s.project_key}`, sub: `${scopeName(s)} · ${s.environment}`, right: <ExpiryBadge secret={s} />,
    })),
  ]

  const sorted = [...projects].sort(
    (a, b) => SEVERITY[a.health_status] - SEVERITY[b.health_status] || b.failing_jobs - a.failing_jobs || a.name.localeCompare(b.name),
  )

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'} · ${active.length} health check${active.length === 1 ? '' : 's'}`}
        actions={user && isAdmin(user.role) && <Link to="/projects/new"><Button>New project</Button></Link>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Checks down" value={down.length} tone={down.length ? 'red' : undefined} />
        <Stat label="Checks degraded" value={degraded.length} tone={degraded.length ? 'amber' : undefined} />
        {meta?.modules.scheduler && <Stat label="Failing jobs" value={failingJobs.length} tone={failingJobs.length ? 'red' : undefined} />}
        {meta?.modules.vault && <Stat label="Keys expiring (30 days)" value={expiring.length} tone={expiring.length ? 'amber' : undefined} />}
      </div>

      {projects.length > 0 &&
        (items.length > 0 ? (
          <Card className="mb-6 overflow-hidden">
            <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">Needs attention · {items.length}</div>
            <ul className="divide-y divide-zinc-800/70">
              {items.slice(0, 12).map((i) => (
                <li key={i.id}>
                  <Link to={i.to} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Badge tone={i.tone}>{i.label}</Badge>
                      <span className="min-w-0">
                        <span className="text-zinc-100">{i.title}</span>
                        <span className="ml-2 text-xs text-zinc-500">{i.sub}</span>
                      </span>
                    </span>
                    {i.right}
                  </Link>
                </li>
              ))}
            </ul>
            {items.length > 12 && <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">…and {items.length - 12} more</div>}
          </Card>
        ) : (
          <Card className="mb-6 flex items-center gap-3 px-4 py-3 text-sm text-zinc-300">
            <StatusDot status="up" />
            {active.length > 0 ? 'All clear — every check is up and nothing needs attention.' : 'Nothing needs attention. Add health checks to start monitoring your projects.'}
          </Card>
        ))}

      {projects.length === 0 ? (
        <Empty title="No projects yet">Create a project, then add health checks and keepalive jobs to it.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((p) => (
            <Link key={p.id} to={`/projects/${p.key}`}>
              <Card className="h-full p-4 transition hover:border-zinc-600">
                <div className="flex items-center gap-2">
                  <StatusDot status={projectDot(p)} />
                  <span className="truncate font-medium text-zinc-100">{p.name}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-500 mono">{p.key}</div>
                {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{p.description}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  {p.health_status === 'down' && <Badge tone="red">down</Badge>}
                  {p.health_status === 'degraded' && <Badge tone="amber">degraded</Badge>}
                  {p.health_status === 'up' && <Badge tone="green">up</Badge>}
                  <Badge>{p.check_count} check{p.check_count === 1 ? '' : 's'}</Badge>
                  <Badge>{p.job_count} job{p.job_count === 1 ? '' : 's'}</Badge>
                  {p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} failing</Badge>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'amber' }) {
  const color = tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : 'text-zinc-100'
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </Card>
  )
}

export function ProjectNewPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ project: Project }>('/api/projects', { method: 'POST', body: { name, key, description } })
      navigate(`/projects/${r.project.key}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="New project" />
      <Card className="max-w-xl p-5">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!keyTouched) setKey(slugify(e.target.value))
              }}
              autoFocus
              required
            />
          </Field>
          <Field label="Project key" hint={KEY_HINT}>
            <Input
              value={key}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value.toLowerCase())
              }}
              className="mono"
              required
            />
          </Field>
          <Field label="Description (optional)">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Field>
          <ErrorBox error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</Button>
            <Link to="/"><Button type="button" variant="ghost">Cancel</Button></Link>
          </div>
        </form>
      </Card>
    </>
  )
}

export function ProjectDetailPage() {
  const { key = '' } = useParams()
  const { user, meta } = useAuth()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  // '' = all services, '-' = the project directly, otherwise a service ID.
  const [scope, setScope] = useState('')
  const writable = !!user && canWrite(user.role)
  const admin = !!user && isAdmin(user.role) // project settings, structure and access are owner/admin only
  const { services, reload: reloadServices } = useServices(key)

  const load = useCallback(async () => {
    try {
      const r = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(key)}`)
      setProject(r.project)
      if (meta?.modules.scheduler) {
        const j = await api<{ jobs: Job[] }>(`/api/jobs?project=${encodeURIComponent(key)}${serviceQuery(scope)}`)
        setJobs(j.jobs)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [key, meta, scope])

  // A deleted (or renamed-away) service can't stay selected.
  useEffect(() => {
    if (services && scope && scope !== '-' && !services.some((s) => s.id === scope)) setScope('')
  }, [services, scope])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <ErrorBox error={error} persistent />
  if (!project || !services) return <Spinner />

  const remove = async () => {
    if (!confirm(`Delete project "${project.name}" with all its health checks, jobs and secrets? This cannot be undone.`)) return
    try {
      await api(`/api/projects/${project.key}`, { method: 'DELETE' })
      navigate('/')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={<span className="mono">{project.key}{project.owner_only && <span className="ml-2 rounded border border-amber-800 px-1.5 py-0.5 text-[10px] uppercase text-amber-400">owner only</span>}</span>}
        actions={
          admin && !editing && (
            <ActionMenu
              items={[
                { label: 'Edit project', onClick: () => setEditing(true) },
                { label: 'Access…', onClick: () => setAccessOpen(true) },
                { label: 'Delete project', onClick: remove, danger: true },
              ]}
            />
          )
        }
      />
      {editing ? (
        <ProjectEditForm
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={(p) => {
            setEditing(false)
            if (p.key !== project.key) navigate(`/projects/${p.key}`, { replace: true })
            else setProject(p)
          }}
        />
      ) : (
        project.description && <p className="mb-6 max-w-3xl whitespace-pre-wrap text-sm text-zinc-400">{project.description}</p>
      )}

      <ProjectServices
        project={project}
        services={services}
        onChanged={() => {
          reloadServices()
          load()
        }}
      />

      {services.length > 0 && <ScopeBar services={services} value={scope} onChange={setScope} />}

      <ProjectChecks project={project} services={services} scope={scope} />

      {meta?.modules.vault && <ProjectVault project={project} services={services} scope={scope} onChanged={reloadServices} />}

      {meta?.modules.vault && <ProjectDeployTokens project={project} services={services} writable={writable} />}

      {accessOpen && <ProjectAccessModal project={project} onClose={() => setAccessOpen(false)} onChanged={load} />}

      {meta?.modules.scheduler && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium text-zinc-200">Jobs</h2>
            {writable && (
              <Link to={`/jobs/new?project=${project.key}${scope && scope !== '-' ? `&service=${scope}` : ''}`}>
                <Button variant="secondary">Add job</Button>
              </Link>
            )}
          </div>
          {jobs.length === 0 ? (
            <Empty title={scope ? 'No jobs here' : 'No jobs for this project'}>Add a keepalive or ping job to keep services awake.</Empty>
          ) : (
            <JobTable jobs={jobs} showProject={false} />
          )}
        </section>
      )}
    </>
  )
}

function ProjectEditForm({ project, onCancel, onSaved }: { project: Project; onCancel: () => void; onSaved: (p: Project) => void }) {
  const [name, setName] = useState(project.name)
  const [key, setKey] = useState(project.key)
  const [description, setDescription] = useState(project.description)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const renaming = key !== project.key

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (renaming && !confirm(`Rename key "${project.key}" → "${key}"?\n\nThe old key stops working immediately. Update any tools that use it (e.g. your CRM).`)) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ project: Project }>(`/api/projects/${project.key}`, { method: 'PATCH', body: { name, key, description } })
      onSaved(r.project)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6 max-w-xl p-5">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Project key" hint={KEY_HINT}>
          <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="mono" required />
        </Field>
        {renaming && (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
            Tools using <code>{project.key}</code> (e.g. your CRM) must be updated after renaming.
          </div>
        )}
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  )
}
