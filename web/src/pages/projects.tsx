import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, canWrite, type Job, type Project } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Spinner, StatusDot, Textarea, timeAgo } from '../ui'
import { JobTable } from './jobs'

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

export function DashboardPage() {
  const { user, meta } = useAuth()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message))
    if (meta?.modules.scheduler) {
      api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => {})
    }
  }, [meta])

  if (error) return <ErrorBox error={error} />
  if (!projects) return <Spinner />

  const enabled = jobs.filter((j) => j.enabled)
  const failing = enabled.filter((j) => j.last_status === 'failed')

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
        actions={user && canWrite(user.role) && <Link to="/projects/new"><Button>New project</Button></Link>}
      />

      {meta?.modules.scheduler && (
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Active jobs" value={enabled.length} />
          <Stat label="Failing jobs" value={failing.length} tone={failing.length ? 'red' : undefined} />
          <Stat label="Paused jobs" value={jobs.length - enabled.length} />
        </div>
      )}

      {projects.length === 0 ? (
        <Empty title="No projects yet">Create a project, then add keepalive jobs to it.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const pj = jobs.filter((j) => j.project_id === p.id)
            const last = pj.map((j) => j.last_run_at).filter(Boolean).sort().pop() ?? null
            const status = p.failing_jobs > 0 ? 'failed' : pj.some((j) => j.last_status === 'success') ? 'success' : 'none'
            return (
              <Link key={p.id} to={`/projects/${p.key}`}>
                <Card className="h-full p-4 transition hover:border-zinc-600">
                  <div className="flex items-center gap-2">
                    <StatusDot status={status} />
                    <span className="truncate font-medium text-zinc-100">{p.name}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500 mono">{p.key}</div>
                  {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{p.description}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <Badge>{p.job_count} job{p.job_count === 1 ? '' : 's'}</Badge>
                    {p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} failing</Badge>}
                    {last && <span>last run {timeAgo(last)}</span>}
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={tone === 'red' ? 'mt-1 text-2xl font-semibold text-red-400' : 'mt-1 text-2xl font-semibold text-zinc-100'}>{value}</div>
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
  const writable = !!user && canWrite(user.role)

  const load = useCallback(async () => {
    try {
      const r = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(key)}`)
      setProject(r.project)
      if (meta?.modules.scheduler) {
        const j = await api<{ jobs: Job[] }>(`/api/jobs?project=${encodeURIComponent(key)}`)
        setJobs(j.jobs)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [key, meta])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <ErrorBox error={error} />
  if (!project) return <Spinner />

  const remove = async () => {
    if (!confirm(`Delete project "${project.name}" and all its jobs? This cannot be undone.`)) return
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
        subtitle={<span className="mono">{project.key}</span>}
        actions={
          writable && !editing && (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="danger" onClick={remove}>Delete</Button>
            </>
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

      {meta?.modules.scheduler && (
        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium text-zinc-200">Jobs</h2>
            {writable && (
              <Link to={`/jobs/new?project=${project.key}`}>
                <Button variant="secondary">Add job</Button>
              </Link>
            )}
          </div>
          {jobs.length === 0 ? (
            <Empty title="No jobs for this project">Add a keepalive or ping job to keep services awake.</Empty>
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
