import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, canWrite, isAdmin, type Job, type Project } from '../api'
import { useAuth } from '../auth'
import { NavIcon } from '../icons'
import { ActionMenu, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatusDot, Textarea, WebsiteLink, cx, hostOf, type DotStatus } from '../ui'
import { JobTable } from './jobs'
import { ProjectChecks } from './health'
import { ProjectVault } from './vault'
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

const SEVERITY: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3, none: 4 }

function projectDot(p: Project): DotStatus {
  if (p.health_status !== 'none') return p.health_status
  if (p.failing_jobs > 0) return 'failed'
  return 'none'
}

type HealthFilter = 'all' | 'down' | 'degraded' | 'up' | 'none' | 'failing'
type SortKey = 'health' | 'name' | 'recent'
type View = 'grid' | 'list'

const VIEW_KEY = 'rexus.projects.view'

function healthLabel(p: Project) {
  if (p.health_status === 'none') return 'No checks'
  return p.health_status === 'unknown' ? 'Checking…' : p.health_status[0].toUpperCase() + p.health_status.slice(1)
}

function HealthTag({ p }: { p: Project }) {
  const tone = p.health_status === 'down' ? 'red' : p.health_status === 'degraded' ? 'amber' : p.health_status === 'up' ? 'green' : 'zinc'
  return <Badge tone={tone}>{healthLabel(p)}</Badge>
}

/** The project directory: search, filter by health, sort, and a grid or compact list. */
export function ProjectsPage() {
  const { user, meta } = useAuth()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [health, setHealth] = useState<HealthFilter>('all')
  const [sort, setSort] = useState<SortKey>('health')
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const scheduler = !!meta?.modules.scheduler

  const load = useCallback(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => {
        setProjects(r.projects)
        setError(null)
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const chooseView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // not persisted — still applies now
    }
  }

  const shown = useMemo(() => {
    if (!projects) return []
    const q = query.trim().toLowerCase()
    const rows = projects.filter((p) => {
      if (q && !`${p.name} ${p.key} ${p.description}`.toLowerCase().includes(q)) return false
      if (health === 'failing') return p.failing_jobs > 0
      if (health === 'all') return true
      return p.health_status === health
    })
    return rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'recent') return b.created_at.localeCompare(a.created_at)
      return SEVERITY[a.health_status] - SEVERITY[b.health_status] || b.failing_jobs - a.failing_jobs || a.name.localeCompare(b.name)
    })
  }, [projects, query, health, sort])

  if (error && !projects) return <ErrorBox error={error} persistent />
  if (!projects) return <Spinner />

  const filtering = query.trim() !== '' || health !== 'all'

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
        actions={user && isAdmin(user.role) && <Link to="/projects/new"><Button>New project</Button></Link>}
      />
      {error && <ErrorBox error={`Couldn't refresh: ${error}`} />}

      {projects.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-[1_1_12rem] sm:max-w-xs">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-500"><NavIcon name="search" size={16} /></span>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="pl-8" />
          </div>
          <Select value={health} onChange={(e) => setHealth(e.target.value as HealthFilter)} aria-label="Filter by health" className="w-auto! max-w-full">
            <option value="all">All health</option>
            <option value="down">Down</option>
            <option value="degraded">Degraded</option>
            <option value="up">Up</option>
            <option value="none">No checks</option>
            {scheduler && <option value="failing">Failing jobs</option>}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort projects" className="w-auto! max-w-full">
            <option value="health">Sort: needs attention</option>
            <option value="name">Sort: name</option>
            <option value="recent">Sort: newest</option>
          </Select>
          <div className="ml-auto inline-flex shrink-0 overflow-hidden rounded-md border border-zinc-700" role="group" aria-label="Layout">
            {(['grid', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => chooseView(v)}
                aria-pressed={view === v}
                aria-label={v === 'grid' ? 'Grid view' : 'List view'}
                title={v === 'grid' ? 'Grid view' : 'List view'}
                className={cx('px-2.5 py-2', view === v ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900')}
              >
                <NavIcon name={v} size={16} />
              </button>
            ))}
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <Empty title="No projects yet">
          {user && isAdmin(user.role)
            ? 'Create a project, then add health checks and keepalive jobs to it.'
            : 'Nothing has been shared with you yet. Ask an admin to give you access to a project.'}
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title={filtering ? 'No projects match' : 'No projects'}>
          {filtering && (
            <button className="text-emerald-400 hover:underline" onClick={() => { setQuery(''); setHealth('all') }}>Clear search and filters</button>
          )}
        </Empty>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <div key={p.id} className="relative">
            <Link to={`/projects/${p.key}`} className="block h-full">
              <Card className="h-full p-4 transition hover:border-zinc-600">
                <div className={cx('flex items-center gap-2', p.website_url && 'pr-8')}>
                  <StatusDot status={projectDot(p)} />
                  <span className="truncate font-medium text-zinc-100">{p.name}</span>
                </div>
                <div className="mt-1 truncate text-xs text-zinc-500 mono">{p.key}</div>
                {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{p.description}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <HealthTag p={p} />
                  <Badge>{p.check_count} check{p.check_count === 1 ? '' : 's'}</Badge>
                  {scheduler && <Badge>{p.job_count} job{p.job_count === 1 ? '' : 's'}</Badge>}
                  {scheduler && p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} failing</Badge>}
                </div>
              </Card>
            </Link>
            {p.website_url && (
              <WebsiteLink url={p.website_url} className="absolute right-3 top-3.5 rounded p-1 text-zinc-400 hover:bg-zinc-800" title={`Open ${hostOf(p.website_url)}`} />
            )}
            </div>
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-zinc-800 text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Website</th>
                <th className="px-4 py-2 text-right font-medium">Checks</th>
                {scheduler && <th className="px-4 py-2 text-right font-medium">Jobs</th>}
                {scheduler && <th className="px-4 py-2 text-right font-medium">Failing</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {shown.map((p) => (
                <tr key={p.id} className="hover:bg-zinc-800/30">
                  <td className="max-w-[22rem] px-4 py-2">
                    <Link to={`/projects/${p.key}`} className="block">
                      <span className="flex items-center gap-2">
                        <StatusDot status={projectDot(p)} />
                        <span className="truncate text-zinc-100">{p.name}</span>
                        <span className="truncate text-xs text-zinc-500 mono">{p.key}</span>
                      </span>
                      {p.description && <span className="mt-0.5 block truncate pl-[18px] text-xs text-zinc-500">{p.description}</span>}
                    </Link>
                  </td>
                  <td className="px-4 py-2"><HealthTag p={p} /></td>
                  <td className="px-4 py-2 text-xs">{p.website_url ? <WebsiteLink url={p.website_url} label={hostOf(p.website_url)} /> : <span className="text-zinc-600">—</span>}</td>
                  <td className="px-4 py-2 text-right text-zinc-300">{p.check_count}</td>
                  {scheduler && <td className="px-4 py-2 text-right text-zinc-300">{p.job_count}</td>}
                  {scheduler && <td className={cx('px-4 py-2 text-right', p.failing_jobs > 0 ? 'text-red-400' : 'text-zinc-500')}>{p.failing_jobs}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}

export function ProjectNewPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ project: Project }>('/api/projects', { method: 'POST', body: { name, key, description, website_url: website } })
      navigate(`/projects/${r.project.key}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="New project" crumbs={[{ label: 'Projects', to: '/projects' }, { label: 'New project' }]} />
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
          <Field label="Website (optional)" hint="For quick access — shows as a link on the dashboard and project pages.">
            <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} className="mono" placeholder="https://app.example.com" />
          </Field>
          <Field label="Description (optional)">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Field>
          <ErrorBox error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</Button>
            <Link to="/projects"><Button type="button" variant="ghost">Cancel</Button></Link>
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

  // Breadcrumb links such as /projects/x#checks scroll to that section once the page has loaded.
  const { hash } = useLocation()
  const ready = !!project && !!services
  useEffect(() => {
    if (ready && hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [ready, hash])

  if (error) return <ErrorBox error={error} persistent />
  if (!project || !services) return <Spinner />

  const remove = async () => {
    if (!confirm(`Delete project "${project.name}" with all its health checks, jobs and secrets? This cannot be undone.`)) return
    try {
      await api(`/api/projects/${project.key}`, { method: 'DELETE' })
      navigate('/projects')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name }]}
        title={project.name}
        subtitle={<span className="mono">{project.key}{project.owner_only && <span className="ml-2 rounded border border-amber-800 px-1.5 py-0.5 text-[10px] uppercase text-amber-400">owner only</span>}</span>}
        actions={
          <>
            {project.website_url && (
              <a href={project.website_url} target="_blank" rel="noopener noreferrer" title={`Open ${project.website_url}`}>
                <Button variant="secondary">
                  {hostOf(project.website_url)}
                  <NavIcon name="external" size={14} />
                </Button>
              </a>
            )}
            {admin && !editing && (
              <ActionMenu
                items={[
                  { label: 'Edit project', onClick: () => setEditing(true) },
                  { label: 'Access…', onClick: () => setAccessOpen(true) },
                  { label: 'Delete project', onClick: remove, danger: true },
                ]}
              />
            )}
          </>
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
        <section id="jobs" className="mt-8 scroll-mt-6">
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
  const [website, setWebsite] = useState(project.website_url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const renaming = key !== project.key

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (renaming && !confirm(`Rename key "${project.key}" → "${key}"?\n\nThe old key stops working immediately. Update any tools that use it (e.g. your CRM).`)) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ project: Project }>(`/api/projects/${project.key}`, { method: 'PATCH', body: { name, key, description, website_url: website } })
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
        <Field label="Website" hint="For quick access — shows as a link on the dashboard and project pages. Leave empty for none.">
          <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} className="mono" placeholder="https://app.example.com" />
        </Field>
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
