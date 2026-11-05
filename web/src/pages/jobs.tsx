import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, canWrite, type Job, type JobRun, type Project } from '../api'
import { useAuth } from '../auth'
import { EnvBadge, EnvironmentSelect, ServiceBadge, ServiceSelect, useEnvironments, useServices } from './services'
import {
  Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatusDot, Textarea, cx, fmtTime, timeAgo,
} from '../ui'

const PRESETS: [string, string][] = [
  ['Every 5 min', '*/5 * * * *'],
  ['Every 15 min', '*/15 * * * *'],
  ['Hourly', '@hourly'],
  ['Daily', '@daily'],
  ['Every 3 days', '0 9 */3 * *'],
]

export function JobTable({ jobs, showProject = true }: { jobs: Job[]; showProject?: boolean }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Job</th>
            {showProject && <th className="px-4 py-2.5 font-medium">Project</th>}
            <th className="px-4 py-2.5 font-medium">Schedule</th>
            <th className="px-4 py-2.5 font-medium">Last run</th>
            <th className="px-4 py-2.5 font-medium">Next run</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {jobs.map((j) => (
            <tr key={j.id} className="hover:bg-zinc-800/30">
              <td className="px-4 py-2.5">
                <Link to={`/jobs/${j.id}`} className="flex items-center gap-2">
                  <StatusDot status={j.enabled ? j.last_status : 'disabled'} />
                  <span className="font-medium text-zinc-100 hover:underline">{j.name}</span>
                  {!j.enabled && <Badge>paused</Badge>}
                  <ServiceBadge r={j} />
                  <EnvBadge env={j.environment} />
                </Link>
                <div className="ml-4.5 mt-0.5 max-w-xs truncate text-xs text-zinc-500 mono">
                  {j.config.method} {j.config.url}
                </div>
              </td>
              {showProject && (
                <td className="px-4 py-2.5 text-zinc-400">
                  <Link to={`/projects/${j.project_key}`} className="hover:underline">{j.project_name}</Link>
                </td>
              )}
              <td className="px-4 py-2.5 text-zinc-400 mono">{j.schedule}</td>
              <td className="px-4 py-2.5 text-zinc-400">{timeAgo(j.last_run_at)}</td>
              <td className="px-4 py-2.5 text-zinc-400">{j.enabled ? timeAgo(j.next_run_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export function JobsPage() {
  const { user } = useAuth()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch((e) => setError(e.message))
  }, [])

  if (error) return <ErrorBox error={error} persistent />
  if (!jobs) return <Spinner />
  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Scheduled pings and keepalives"
        actions={user && canWrite(user.role) && <Link to="/jobs/new"><Button>New job</Button></Link>}
      />
      {jobs.length === 0 ? (
        <Empty title="No jobs yet">Create a job to ping a website or keep Supabase and other APIs awake.</Empty>
      ) : (
        <JobTable jobs={jobs} />
      )}
    </>
  )
}

interface HeaderRow {
  name: string
  value: string
}

export function JobFormPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const editing = !!id

  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(!editing)
  const [name, setName] = useState('')
  const [projectKey, setProjectKey] = useState(params.get('project') ?? '')
  const [serviceId, setServiceId] = useState(params.get('service') ?? '')
  const [environmentId, setEnvironmentId] = useState('')
  const { meta } = useAuth()
  const { services } = useServices(projectKey)
  const envs = useEnvironments(projectKey, !!meta?.modules.vault)
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [schedule, setSchedule] = useState('*/15 * * * *')
  const [headers, setHeaders] = useState<HeaderRow[]>([])
  const [body, setBody] = useState('')
  const [expected, setExpected] = useState('200-299')
  const [timeout, setTimeoutS] = useState(30)
  const [retries, setRetries] = useState(1)
  const [enabled, setEnabled] = useState(true)
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; next?: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects)).catch(() => {})
    if (!id) return
    api<{ job: Job }>(`/api/jobs/${id}`)
      .then(({ job }) => {
        setName(job.name)
        setProjectKey(job.project_key)
        setServiceId(job.service_id ?? '')
        setEnvironmentId(job.environment_id ?? '')
        setMethod(job.config.method)
        setUrl(job.config.url)
        setSchedule(job.schedule)
        setHeaders(Object.entries(job.headers ?? {}).map(([n, v]) => ({ name: n, value: v })))
        setBody(job.config.body ?? '')
        setExpected(job.config.expected_status)
        setTimeoutS(job.timeout_seconds)
        setRetries(job.retries)
        setEnabled(job.enabled)
        setLoaded(true)
      })
      .catch((e) => setError(e.message))
  }, [id])

  // Live schedule preview (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      if (!schedule.trim()) return setPreview(null)
      api<{ valid: boolean; error?: string; next?: string[] }>(`/api/schedule/preview?expr=${encodeURIComponent(schedule)}`)
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(t)
  }, [schedule])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const payload = {
      name,
      project_key: projectKey,
      service_id: serviceId,
      environment_id: environmentId,
      method,
      url,
      schedule,
      headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])),
      body: method === 'GET' || method === 'HEAD' ? '' : body,
      expected_status: expected,
      timeout_seconds: Number(timeout),
      retries: Number(retries),
      enabled,
    }
    try {
      const r = editing
        ? await api<{ job: Job }>(`/api/jobs/${id}`, { method: 'PUT', body: payload })
        : await api<{ job: Job }>('/api/jobs', { method: 'POST', body: payload })
      navigate(`/jobs/${r.job.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Spinner />

  return (
    <>
      <PageHeader title={editing ? 'Edit job' : 'New job'} subtitle="An HTTP request on a schedule — ping a site or keep an API awake." />
      <Card className="max-w-2xl p-5">
        <form onSubmit={submit} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Supabase keepalive" required autoFocus />
            </Field>
            <Field label="Project" hint={editing ? 'A job stays in its project.' : undefined}>
              <Select
                value={projectKey}
                onChange={(e) => {
                  setProjectKey(e.target.value)
                  setServiceId('')
                  setEnvironmentId('')
                }}
                disabled={editing}
                required
              >
                <option value="" disabled>Choose a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>{p.name} ({p.key})</option>
                ))}
              </Select>
            </Field>
          </div>

          {projectKey && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Service" hint={services && services.length === 0 ? 'This project has no services — the job belongs to the project.' : undefined}>
                <ServiceSelect services={services ?? []} value={serviceId} onChange={setServiceId} disabled={!services?.length} />
              </Field>
              {envs.length > 0 && (
                <Field label="Environment" hint="Optional — e.g. a job that only pings staging">
                  <EnvironmentSelect envs={envs} value={environmentId} onChange={setEnvironmentId} />
                </Field>
              )}
            </div>
          )}

          <Field label="Request">
            <div className="flex gap-2">
              <div className="w-28 shrink-0">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
                </Select>
              </div>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xyz.supabase.co/rest/v1/" className="mono" required />
            </div>
          </Field>

          <Field
            label="Schedule"
            hint={
              preview?.valid ? (
                <>Next runs: {preview.next?.map((t) => new Date(t).toLocaleString()).join(' · ')}</>
              ) : preview?.error ? (
                <span className="text-red-400">{preview.error}</span>
              ) : (
                'Cron (minute hour day month weekday) or @hourly, @daily, @every 30m'
              )
            }
          >
            <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="mono" required />
          </Field>
          <div className="-mt-3 flex flex-wrap gap-1.5">
            {PRESETS.map(([label, expr]) => (
              <button
                type="button"
                key={expr}
                onClick={() => setSchedule(expr)}
                className={cx('rounded border px-2 py-0.5 text-xs', schedule === expr ? 'border-emerald-600 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200')}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-300">Headers</span>
              <button type="button" className="text-xs text-emerald-400 hover:text-emerald-300" onClick={() => setHeaders([...headers, { name: '', value: '' }])}>
                + Add header
              </button>
            </div>
            {headers.length === 0 ? (
              <p className="text-xs text-zinc-500">None. For Supabase add <code>apikey</code> with your anon key. Header values are stored encrypted.</p>
            ) : (
              <div className="space-y-2">
                {headers.map((h, i) => (
                  <div key={i} className="flex gap-2">
                    <div className="w-2/5 shrink-0">
                      <Input value={h.name} placeholder="Header name" className="mono" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    </div>
                    <Input value={h.value} placeholder="Value" className="mono" type="password" autoComplete="off" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <Button type="button" variant="ghost" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label="Remove header">✕</Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {method !== 'GET' && method !== 'HEAD' && (
            <Field label="Body (optional)">
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="mono" />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Expected status" hint="e.g. 200, 200-299, 200,204">
              <Input value={expected} onChange={(e) => setExpected(e.target.value)} className="mono" />
            </Field>
            <Field label="Timeout (seconds)">
              <Input type="number" min={1} max={300} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} />
            </Field>
            <Field label="Retries" hint="Extra attempts on failure">
              <Input type="number" min={0} max={5} value={retries} onChange={(e) => setRetries(Number(e.target.value))} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
            Enabled
          </label>

          <ErrorBox error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save job' : 'Create job'}</Button>
            <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  )
}

export function JobDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [job, setJob] = useState<Job | null>(null)
  const [runs, setRuns] = useState<JobRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const writable = !!user && canWrite(user.role)

  const load = useCallback(async () => {
    try {
      const [j, r] = await Promise.all([
        api<{ job: Job }>(`/api/jobs/${id}`),
        api<{ runs: JobRun[] }>(`/api/jobs/${id}/runs?limit=50`),
      ])
      setJob(j.job)
      setRuns(r.runs)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <ErrorBox error={error} persistent />
  if (!job) return <Spinner />

  const runNow = async () => {
    setRunning(true)
    try {
      await api(`/api/jobs/${job.id}/run`, { method: 'POST' })
      setTimeout(load, 800)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTimeout(() => setRunning(false), 800)
    }
  }

  const toggle = async () => {
    try {
      const r = await api<{ job: Job }>(`/api/jobs/${job.id}`, {
        method: 'PUT',
        body: {
          name: job.name,
          project_key: job.project_key,
          method: job.config.method,
          url: job.config.url,
          body: job.config.body ?? '',
          expected_status: job.config.expected_status,
          schedule: job.schedule,
          headers: job.headers,
          timeout_seconds: job.timeout_seconds,
          retries: job.retries,
          enabled: !job.enabled,
        },
      })
      setJob(r.job)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete job "${job.name}" and its run history?`)) return
    try {
      await api(`/api/jobs/${job.id}`, { method: 'DELETE' })
      navigate(`/projects/${job.project_key}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const ok = runs.filter((r) => r.status === 'success').length
  const done = runs.filter((r) => r.status !== 'running').length

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <StatusDot status={job.enabled ? job.last_status : 'disabled'} />
            {job.name}
            {!job.enabled && <Badge>paused</Badge>}
          </span>
        }
        subtitle={
          <>
            Project: <Link to={`/projects/${job.project_key}`} className="text-zinc-300 hover:underline">{job.project_name}</Link>
            {job.service_name && <span className="text-zinc-400"> / {job.service_name}</span>}
            {job.environment && <span className="ml-2"><EnvBadge env={job.environment} /></span>}
          </>
        }
        actions={
          writable && (
            <>
              <Button onClick={runNow} disabled={running}>{running ? 'Running…' : 'Run now'}</Button>
              <Button variant="secondary" onClick={toggle}>{job.enabled ? 'Pause' : 'Resume'}</Button>
              <Link to={`/jobs/${job.id}/edit`}><Button variant="secondary">Edit</Button></Link>
              <Button variant="danger" onClick={remove}>Delete</Button>
            </>
          )
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Info label="Request" value={<span className="mono">{job.config.method} {job.config.url}</span>} wide />
        <Info label="Schedule" value={<span className="mono">{job.schedule}</span>} />
        <Info label="Next run" value={job.enabled ? `${timeAgo(job.next_run_at)}` : 'paused'} />
        <Info label="Expected status" value={<span className="mono">{job.config.expected_status}</span>} />
        <Info label="Timeout / retries" value={`${job.timeout_seconds}s / ${job.retries}`} />
        <Info label="Success rate (recent)" value={done ? `${Math.round((ok / done) * 100)}% of ${done}` : '—'} />
      </div>

      <h2 className="mb-3 font-medium text-zinc-200">Run history</h2>
      {runs.length === 0 ? (
        <Empty title="No runs yet">{job.enabled ? `First run ${timeAgo(job.next_run_at)}.` : 'Job is paused.'}</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="px-4 py-2.5 font-medium">HTTP</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Attempts</th>
                <th className="px-4 py-2.5 font-medium">Trigger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}

function RunRow({ run, open, onToggle }: { run: JobRun; open: boolean; onToggle: () => void }) {
  const tone = run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'sky'
  return (
    <>
      <tr className="cursor-pointer hover:bg-zinc-800/30" onClick={onToggle}>
        <td className="px-4 py-2.5"><Badge tone={tone}>{run.status}</Badge></td>
        <td className="px-4 py-2.5 text-zinc-400" title={fmtTime(run.started_at)}>{timeAgo(run.started_at)}</td>
        <td className="px-4 py-2.5 text-zinc-400 mono">{run.status_code ?? '—'}</td>
        <td className="px-4 py-2.5 text-zinc-400">{run.duration_ms != null ? `${run.duration_ms} ms` : '—'}</td>
        <td className="px-4 py-2.5 text-zinc-400">{run.attempts}</td>
        <td className="px-4 py-2.5 text-zinc-400">{run.trigger}</td>
      </tr>
      {open && (
        <tr className="bg-zinc-950/50">
          <td colSpan={6} className="space-y-2 px-4 py-3 text-xs">
            <div className="text-zinc-500">Started {fmtTime(run.started_at)} · finished {fmtTime(run.finished_at)}</div>
            {run.error && <div className="text-red-300 mono">Error: {run.error}</div>}
            {run.response_snippet && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-2 text-zinc-400 mono">{run.response_snippet}</pre>
            )}
            {!run.error && !run.response_snippet && <div className="text-zinc-500">No response body.</div>}
          </td>
        </tr>
      )}
    </>
  )
}

function Info({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <Card className={cx('min-w-0 px-4 py-3', wide && 'col-span-2')}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 truncate text-sm text-zinc-200">{value}</div>
    </Card>
  )
}
