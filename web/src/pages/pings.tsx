import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, canWrite, type HealthCheck, type Job } from '../api'
import { useAuth } from '../auth'
import { SystemJobs } from './system_jobs'
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Select, Spinner, StatusDot, cx, timeAgo } from '../ui'
import { fmtPct, HealthBadge } from './health'
import { EnvBadge, ServiceBadge } from './services'

type Kind = 'check' | 'job'
type PingState = 'down' | 'failing' | 'degraded' | 'unknown' | 'healthy' | 'paused'

/** One health check or job, in the shape the table needs. */
interface Ping {
  kind: Kind
  id: string
  name: string
  projectKey: string
  projectName: string
  state: PingState
  enabled: boolean
  check?: HealthCheck
  job?: Job
}

/** Worst first: what needs a person comes before what is fine, paused last. */
const RANK: Record<PingState, number> = { down: 0, failing: 0, degraded: 1, unknown: 2, healthy: 3, paused: 4 }

const STATUS_FILTERS: { id: string; label: string; match: (p: Ping) => boolean }[] = [
  { id: '', label: 'Any status', match: () => true },
  { id: 'attention', label: 'Needs attention', match: (p) => p.state === 'down' || p.state === 'failing' || p.state === 'degraded' },
  { id: 'down', label: 'Down', match: (p) => p.state === 'down' },
  { id: 'degraded', label: 'Degraded', match: (p) => p.state === 'degraded' },
  { id: 'failing', label: 'Job failing', match: (p) => p.state === 'failing' },
  { id: 'healthy', label: 'Healthy', match: (p) => p.state === 'healthy' },
  { id: 'paused', label: 'Paused', match: (p) => p.state === 'paused' },
]

function toPings(checks: HealthCheck[], jobs: Job[]): Ping[] {
  const fromChecks = checks.map((c): Ping => ({
    kind: 'check', id: c.id, name: c.name, projectKey: c.project_key, projectName: c.project_name, enabled: c.enabled, check: c,
    state: !c.enabled ? 'paused' : c.status === 'down' ? 'down' : c.status === 'degraded' ? 'degraded' : c.status === 'up' ? 'healthy' : 'unknown',
  }))
  const fromJobs = jobs.map((j): Ping => ({
    kind: 'job', id: j.id, name: j.name, projectKey: j.project_key, projectName: j.project_name, enabled: j.enabled, job: j,
    state: !j.enabled ? 'paused' : j.last_status === 'failed' ? 'failing' : j.last_status === 'success' ? 'healthy' : 'unknown',
  }))
  return [...fromChecks, ...fromJobs]
}

/** One place for everything that pings: health checks (always on) and scheduled jobs (scheduler module). */
export function PingsPage() {
  const { user, meta } = useAuth()
  const navigate = useNavigate()
  const scheduler = !!meta?.modules.scheduler
  const writable = !!user && canWrite(user.role)
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // "kind:id" of the row being changed, or "project"
  const [params, setParams] = useSearchParams()

  const q = params.get('q') ?? ''
  const project = params.get('project') ?? ''
  const status = STATUS_FILTERS.some((f) => f.id === params.get('status')) ? (params.get('status') as string) : ''
  const type = params.get('type') === 'check' || params.get('type') === 'job' ? (params.get('type') as Kind) : ''
  const sort = params.get('sort') === 'name' ? 'name' : 'worst'
  const setParam = (name: string, value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (value) next.set(name, value)
      else next.delete(name)
      return next
    }, { replace: true })

  const load = useCallback(() => {
    api<{ checks: HealthCheck[] }>('/api/checks').then((r) => setChecks(r.checks)).catch((e) => setError(e.message))
    if (scheduler) api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch((e) => setError(e.message))
  }, [scheduler])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  const all = useMemo(() => (checks && (!scheduler || jobs) ? toPings(checks, jobs ?? []) : null), [checks, jobs, scheduler])

  if (error && !checks && !jobs) return <ErrorBox error={error} persistent />
  if (!all) return <Spinner />

  const projects = [...new Map(all.map((p) => [p.projectKey, p.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const needle = q.trim().toLowerCase()
  const statusMatch = STATUS_FILTERS.find((f) => f.id === status)!.match
  const shown = all
    .filter((p) => (!project || p.projectKey === project) && (!type || p.kind === type) && statusMatch(p))
    .filter((p) => !needle || `${p.name} ${p.projectName} ${p.check?.url ?? ''} ${p.job?.config.url ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'worst' ? RANK[a.state] - RANK[b.state] : 0) || a.name.localeCompare(b.name))
  const filtered = !!(q || project || status || type)

  const act = async (p: Ping, what: 'run' | 'toggle') => {
    setBusy(`${p.kind}:${p.id}`)
    setError(null)
    try {
      const base = p.kind === 'check' ? `/api/checks/${p.id}` : `/api/jobs/${p.id}`
      if (what === 'run') {
        await api(`${base}/run`, { method: 'POST' })
        setNotice(`Running "${p.name}" now — the result shows up in a few seconds.`)
        setTimeout(load, 3000)
      } else {
        await api(base, { method: 'PATCH', body: { enabled: !p.enabled } })
        setNotice(`${p.enabled ? 'Paused' : 'Resumed'} "${p.name}".`)
        load()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Bulk pause works on one project at a time: pause everything unless everything is already paused.
  const inProject = project ? all.filter((p) => p.projectKey === project) : []
  const allPaused = inProject.length > 0 && inProject.every((p) => !p.enabled)
  const projectName = projects.find(([k]) => k === project)?.[1] ?? project
  const bulk = async () => {
    const pausing = !allPaused
    const n = inProject.filter((p) => p.enabled === pausing).length
    const msg = pausing
      ? `Pause all ${n} health checks and jobs in "${projectName}"?\n\nThey stop running and won't alert until you resume them.`
      : `Resume all paused health checks and jobs in "${projectName}"?`
    if (!confirm(msg)) return
    setBusy('project')
    setError(null)
    try {
      const r = await api<{ checks: number; jobs: number }>(`/api/projects/${encodeURIComponent(project)}/pause`, { method: 'POST', body: { paused: pausing } })
      setNotice(`${pausing ? 'Paused' : 'Resumed'} ${r.checks} check${r.checks === 1 ? '' : 's'} and ${r.jobs} job${r.jobs === 1 ? '' : 's'} in "${projectName}".`)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const rows = (kind: Kind) => shown.filter((p) => p.kind === kind)
  const checkRows = rows('check')
  const jobRows = rows('job')
  const total = (kind: Kind) => all.filter((p) => p.kind === kind).length
  const clear = () => setParams(new URLSearchParams(), { replace: true })

  return (
    <>
      <PageHeader
        title={scheduler ? 'Pings' : 'Health'}
        actions={writable && (
          <>
            <Link to={`/checks/new${project ? `?project=${project}` : ''}`}><Button variant={scheduler ? 'secondary' : 'primary'}>New check</Button></Link>
            {scheduler && <Link to={`/jobs/new${project ? `?project=${project}` : ''}`}><Button>New job</Button></Link>}
          </>
        )}
      />

      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="Search name, project or URL…"
            aria-label="Search"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 sm:w-64"
          />
          {projects.length > 1 && (
            <Select value={project} onChange={(e) => setParam('project', e.target.value)} aria-label="Project" className="w-auto!">
              <option value="">All projects</option>
              {projects.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </Select>
          )}
          <Select value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Status" className="w-auto!">
            {STATUS_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
          {scheduler && (
            <Select value={type} onChange={(e) => setParam('type', e.target.value)} aria-label="Type" className="w-auto!">
              <option value="">Checks &amp; jobs</option>
              <option value="check">Health checks</option>
              <option value="job">Jobs</option>
            </Select>
          )}
          <Select value={sort} onChange={(e) => setParam('sort', e.target.value === 'worst' ? '' : e.target.value)} aria-label="Sort" className="w-auto!">
            <option value="worst">Worst first</option>
            <option value="name">Name</option>
          </Select>
          {filtered && <button type="button" onClick={clear} className="text-sm text-zinc-400 hover:text-zinc-200 hover:underline">Clear filters</button>}
          {writable && project && (
            <Button variant="secondary" className="ml-auto" onClick={bulk} disabled={busy === 'project'}>
              {allPaused ? `Resume all in ${projectName}` : `Pause all in ${projectName}`}
            </Button>
          )}
        </div>
      )}

      {notice && <div role="status" className="mb-4 rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
      <ErrorBox error={error} />

      {all.length === 0 ? (
        <Empty title="Nothing is pinging yet">
          Add a health check to watch a site or API{scheduler ? ', or a job to ping it on a schedule' : ''}.
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title="Nothing matches these filters">
          <button type="button" onClick={clear} className="text-emerald-400 hover:underline">Clear filters</button>
        </Empty>
      ) : (
        <>
          {type !== 'job' && (
            <Section title="Health checks" shown={checkRows.length} total={total('check')} empty={checkRows.length === 0 && !filtered ? 'No health checks yet. Add one to watch a site or API: status code, response time and SSL expiry.' : null}>
              {checkRows.length > 0 && (
                <PingTable
                  rows={checkRows}
                  writable={writable}
                  busy={busy}
                  onAct={act}
                  onEdit={(p) => navigate(`/checks/${p.id}/edit`)}
                  head={['Check', 'Project', 'Status', 'Response', 'Uptime 24h', 'Last checked']}
                  cells={(p) => {
                    const c = p.check!
                    return [
                      <HealthBadge key="s" status={c.status} paused={!c.enabled} />,
                      c.enabled && c.last_response_ms != null ? `${c.last_response_ms} ms` : '—',
                      c.enabled ? fmtPct(c.uptime_24h) : '—',
                      c.last_checked_at ? timeAgo(c.last_checked_at) : 'not yet',
                    ]
                  }}
                />
              )}
            </Section>
          )}
          {scheduler && type !== 'check' && (
            <Section title="Jobs" shown={jobRows.length} total={total('job')} empty={jobRows.length === 0 && !filtered ? 'No jobs yet. Create a job to ping a website or keep Supabase and other APIs awake.' : null}>
              {jobRows.length > 0 && (
                <PingTable
                  rows={jobRows}
                  writable={writable}
                  busy={busy}
                  onAct={act}
                  onEdit={(p) => navigate(`/jobs/${p.id}/edit`)}
                  head={['Job', 'Project', 'Status', 'Schedule', 'Last run', 'Next run']}
                  cells={(p) => {
                    const j = p.job!
                    return [
                      !j.enabled ? <Badge key="s">paused</Badge> : j.last_status === 'failed' ? <Badge key="s" tone="red">failing</Badge> : j.last_status === 'success' ? <Badge key="s" tone="green">ok</Badge> : <Badge key="s">not run yet</Badge>,
                      <span key="sc" className="mono">{j.schedule}</span>,
                      timeAgo(j.last_run_at),
                      j.enabled ? timeAgo(j.next_run_at) : '—',
                    ]
                  }}
                />
              )}
            </Section>
          )}
        </>
      )}
      {user && (user.role === 'owner' || user.role === 'admin') && type !== 'check' && type !== 'job' && !filtered && <SystemJobs />}
    </>
  )
}

function Section({ title, shown, total, empty, children }: { title: string; shown: number; total: number; empty: string | null; children: ReactNode }) {
  if (shown === 0 && !empty) return null // filtered out: the other section is the answer
  return (
    <section className="mb-8">
      <h2 className="mb-2 font-medium text-zinc-200">
        {title} <span className="text-xs font-normal text-zinc-500">· {shown === total ? total : `${shown} of ${total}`}</span>
      </h2>
      {empty ? <Empty title={empty} /> : children}
    </section>
  )
}

function PingTable({ rows, head, cells, writable, busy, onAct, onEdit }: {
  rows: Ping[]
  head: string[]
  cells: (p: Ping) => ReactNode[]
  writable: boolean
  busy: string | null
  onAct: (p: Ping, what: 'run' | 'toggle') => void
  onEdit: (p: Ping) => void
}) {
  const link = (p: Ping) => (p.kind === 'check' ? `/checks/${p.id}` : `/jobs/${p.id}`)
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
          <tr>
            {head.map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}
            {writable && <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {rows.map((p) => {
            const [first, ...rest] = cells(p)
            const r = p.check ?? p.job!
            const working = busy === `${p.kind}:${p.id}` || busy === 'project'
            return (
              <tr key={`${p.kind}:${p.id}`} className={cx('hover:bg-zinc-800/30', !p.enabled && 'opacity-70')}>
                <td className="px-4 py-2.5">
                  <Link to={link(p)} className="flex items-center gap-2">
                    <StatusDot status={p.enabled ? (p.check ? p.check.status : p.job!.last_status) : 'disabled'} />
                    <span className="font-medium text-zinc-100 hover:underline">{p.name}</span>
                    <ServiceBadge r={r} />
                    <EnvBadge env={r.environment} />
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-zinc-400">
                  <Link to={`/projects/${p.projectKey}`} className="hover:underline">{p.projectName}</Link>
                </td>
                <td className="px-4 py-2.5">{first}</td>
                {rest.map((c, i) => <td key={i} className="px-4 py-2.5 text-zinc-400">{c}</td>)}
                {writable && (
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <RowButton disabled={working || !p.enabled} onClick={() => onAct(p, 'run')} title={p.enabled ? 'Run now' : 'Resume to run'}>Run</RowButton>
                    <RowButton disabled={working} onClick={() => onAct(p, 'toggle')}>{p.enabled ? 'Pause' : 'Resume'}</RowButton>
                    <RowButton disabled={working} onClick={() => onEdit(p)}>Edit</RowButton>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

function RowButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="ml-1 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40" {...props}>
      {children}
    </button>
  )
}
