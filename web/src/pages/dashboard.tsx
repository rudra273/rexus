import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, isAdmin, type BackupStatus, type HealthCheck, type Job, type Project, type Secret, type SeriesBucket } from '../api'
import { useAuth } from '../auth'
import { NavIcon } from '../icons'
import { Badge, Button, Card, Empty, PageHeader, Select, Spinner, StatusDot, cx, fmtTime, timeAgo } from '../ui'
import { backupLabel } from './backups'
import { Sparkline, UptimeBar, uptimeOf } from './charts'
import { degradedReason, fmtPct, HealthBadge } from './health'
import { ExpiryBadge } from './vault'

/** One independently loaded part of the dashboard. A failed refresh keeps the last good data. */
interface Section<T> {
  data: T | null
  error: string | null
  at: number | null // when data was last fetched successfully
}

function useSection<T>(): [Section<T>, (p: Promise<T>) => Promise<void>] {
  const [s, setS] = useState<Section<T>>({ data: null, error: null, at: null })
  const run = useCallback(
    (p: Promise<T>) =>
      p.then(
        (data) => setS({ data, error: null, at: Date.now() }),
        (e: Error) => setS((prev) => ({ ...prev, error: e.message })),
      ),
    [],
  )
  return [s, run]
}

interface AllSeries {
  window_seconds: number
  bucket_seconds: number
  series: Record<string, SeriesBucket[]>
}

const REFRESH_MS = 30_000

/** A check that should have reported by now but hasn't (3 intervals, at least 5 minutes). */
function isStale(c: HealthCheck, now: number): boolean {
  if (!c.enabled || !c.last_checked_at) return false
  return now - new Date(c.last_checked_at).getTime() > Math.max(c.interval_seconds * 3, 300) * 1000
}

function scopeName(r: { project_name: string; service_key: string | null }) {
  return r.service_key ? `${r.project_name} / ${r.service_key}` : r.project_name
}

const SEVERITY = { down: 0, degraded: 1, unknown: 2, up: 3, none: 4 } as const

interface AttentionItem {
  id: string
  tone: 'red' | 'amber'
  label: string
  title: string
  sub: string
  to: string
  right?: ReactNode
}

export function DashboardPage() {
  const { user, meta } = useAuth()
  const admin = !!user && isAdmin(user.role)
  const showBackup = admin && !!meta?.backup_enabled
  const [projects, loadProjects] = useSection<Project[]>()
  const [checks, loadChecks] = useSection<HealthCheck[]>()
  const [series, loadSeries] = useSection<AllSeries>()
  const [jobs, loadJobs] = useSection<Job[]>()
  const [secrets, loadSecrets] = useSection<Secret[]>()
  const [backup, loadBackup] = useSection<BackupStatus>()
  const [filter, setFilter] = useState('') // project key, '' = all my projects
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const calls: Promise<void>[] = [
      loadProjects(api<{ projects: Project[] }>('/api/projects').then((r) => r.projects)),
      loadChecks(api<{ checks: HealthCheck[] }>('/api/checks').then((r) => r.checks)),
      loadSeries(api<AllSeries>('/api/checks/series?range=24h')),
    ]
    if (meta?.modules.scheduler) calls.push(loadJobs(api<{ jobs: Job[] }>('/api/jobs').then((r) => r.jobs)))
    if (meta?.modules.vault) calls.push(loadSecrets(api<{ secrets: Secret[] }>('/api/secrets?expiring=30').then((r) => r.secrets)))
    if (showBackup) calls.push(loadBackup(api<BackupStatus>('/api/backups/status')))
    await Promise.all(calls)
    setNow(Date.now())
    setRefreshing(false)
  }, [meta, showBackup, loadProjects, loadChecks, loadSeries, loadJobs, loadSecrets, loadBackup])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Nothing has answered yet.
  if (!projects.data && !projects.error && !checks.data && !checks.error) return <Spinner />

  const inScope = <T extends { project_key: string }>(rows: T[]) => (filter ? rows.filter((r) => r.project_key === filter) : rows)

  const allChecks = checks.data ? inScope(checks.data) : null
  const enabled = allChecks?.filter((c) => c.enabled) ?? []
  const paused = allChecks?.filter((c) => !c.enabled) ?? []
  const stale = enabled.filter((c) => isStale(c, now))
  const down = enabled.filter((c) => c.status === 'down')
  const degraded = enabled.filter((c) => c.status === 'degraded')
  const unknown = enabled.filter((c) => c.status === 'unknown')
  const healthy = enabled.filter((c) => c.status === 'up' && !isStale(c, now))
  const failingJobs = jobs.data ? inScope(jobs.data).filter((j) => j.enabled && j.last_status === 'failed') : null
  const expiring = secrets.data ? inScope(secrets.data) : null

  const failed: string[] = []
  if (projects.error) failed.push('projects')
  if (checks.error) failed.push('health checks')
  if (series.error) failed.push('charts')
  if (meta?.modules.scheduler && jobs.error) failed.push('jobs')
  if (meta?.modules.vault && secrets.error) failed.push('secrets')
  if (showBackup && backup.error) failed.push('backup status')

  const items: AttentionItem[] = [
    ...down.map((c): AttentionItem => ({
      id: `d${c.id}`, tone: 'red', label: 'Down', title: c.name, to: `/checks/${c.id}`,
      sub: `${scopeName(c)}${c.last_error ? ` · ${c.last_error}` : ''}${c.status_since ? ` · since ${timeAgo(c.status_since)}` : ''}`,
    })),
    ...(failingJobs ?? []).map((j): AttentionItem => ({
      id: `j${j.id}`, tone: 'red', label: 'Job failed', title: j.name, to: `/jobs/${j.id}`,
      sub: `${scopeName(j)}${j.last_run_at ? ` · last run ${timeAgo(j.last_run_at)}` : ''}`,
    })),
    ...(expiring ?? []).filter((s) => (s.days_left ?? 0) <= 7).map((s): AttentionItem => ({
      id: `s${s.id}`, tone: 'red', label: 'Key expiring', title: s.name, to: `/projects/${s.project_key}`,
      sub: `${scopeName(s)} · ${s.environment}`, right: <ExpiryBadge secret={s} />,
    })),
    ...degraded.map((c): AttentionItem => ({
      id: `g${c.id}`, tone: 'amber', label: 'Degraded', title: c.name, to: `/checks/${c.id}`,
      sub: `${scopeName(c)} · ${degradedReason(c)}`,
    })),
    ...stale.filter((c) => c.status !== 'down').map((c): AttentionItem => ({
      id: `t${c.id}`, tone: 'amber', label: 'No recent result', title: c.name, to: `/checks/${c.id}`,
      sub: `${scopeName(c)} · last checked ${timeAgo(c.last_checked_at)}`,
    })),
    ...(expiring ?? []).filter((s) => (s.days_left ?? 0) > 7).map((s): AttentionItem => ({
      id: `s${s.id}`, tone: 'amber', label: 'Key expiring', title: s.name, to: `/projects/${s.project_key}`,
      sub: `${scopeName(s)} · ${s.environment}`, right: <ExpiryBadge secret={s} />,
    })),
  ]

  const times = [projects, checks, series, jobs, secrets, backup].map((s) => s.at).filter((t): t is number => t != null)
  const updated = times.length ? Math.min(...times) : null

  const projectOptions = projects.data ? [...projects.data].sort((a, b) => a.name.localeCompare(b.name)) : []
  const shownProjects = projectOptions.filter((p) => !filter || p.key === filter)
  const byProject = new Map<string, HealthCheck[]>()
  for (const c of allChecks ?? []) byProject.set(c.project_id, [...(byProject.get(c.project_id) ?? []), c])
  const monitored = shownProjects
    .filter((p) => byProject.has(p.id))
    .sort((a, b) => SEVERITY[a.health_status] - SEVERITY[b.health_status] || a.name.localeCompare(b.name))
  const unmonitored = shownProjects.filter((p) => !byProject.has(p.id))

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${updated ? `Updated ${timeAgo(new Date(updated).toISOString())}` : 'Not updated yet'} · refreshes every ${REFRESH_MS / 1000}s`}
        actions={
          <>
            {projectOptions.length > 1 && (
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by project" className="w-48">
                <option value="">All projects</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.key}>{p.name}</option>
                ))}
              </Select>
            )}
            <Button variant="secondary" onClick={refresh} disabled={refreshing} aria-label="Refresh now">
              <NavIcon name="refresh" size={16} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />

      {failed.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          Couldn't refresh {failed.join(', ')}. {times.length ? 'Those parts may be out of date.' : 'Those parts are unavailable.'}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Healthy checks"
          unavailable={!allChecks}
          value={`${healthy.length}/${enabled.length}`}
          sub={enabled.length === 0 && allChecks ? 'No active checks' : [unknown.length && `${unknown.length} unknown`, stale.length && `${stale.length} stale`, paused.length && `${paused.length} paused`].filter(Boolean).join(' · ') || 'All reporting'}
          tone={enabled.length > 0 && healthy.length === enabled.length ? 'green' : undefined}
        />
        <Stat label="Checks down" unavailable={!allChecks} value={down.length} tone={down.length ? 'red' : undefined} />
        <Stat label="Checks degraded" unavailable={!allChecks} value={degraded.length} tone={degraded.length ? 'amber' : undefined} />
        {meta?.modules.scheduler && <Stat label="Failing jobs" unavailable={!failingJobs} value={failingJobs?.length ?? 0} tone={failingJobs?.length ? 'red' : undefined} />}
        {meta?.modules.vault && <Stat label="Keys expiring (30 days)" unavailable={!expiring} value={expiring?.length ?? 0} tone={expiring?.length ? 'amber' : undefined} />}
      </div>

      {projects.data && projects.data.length === 0 ? (
        <Empty title="No projects yet">
          {admin ? (
            <>
              <Link to="/projects/new" className="text-emerald-400 hover:underline">Create a project</Link>, then add health checks and keepalive jobs to it.
            </>
          ) : (
            'Nothing has been shared with you yet. Ask an admin to give you access to a project.'
          )}
        </Empty>
      ) : (
        <>
          <AttentionCard items={items} failed={failed.length > 0} noChecks={!!allChecks && enabled.length === 0} />

          {!allChecks ? (
            <Card className="mb-6 px-4 py-3 text-sm text-zinc-400">Health checks are unavailable right now.</Card>
          ) : monitored.length > 0 ? (
            <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {monitored.map((p) => (
                <ProjectHealthCard key={p.id} project={p} checks={byProject.get(p.id) ?? []} series={series.data} now={now} />
              ))}
            </div>
          ) : null}

          {unmonitored.length > 0 && (
            <div className="mb-6 text-sm text-zinc-500">
              <span className="mr-2">No health checks yet:</span>
              {unmonitored.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <Link to={`/projects/${p.key}`} className="text-zinc-300 hover:underline">{p.name}</Link>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {showBackup && <BackupCard section={backup} />}
    </>
  )
}

/** One project: its 24h uptime and, per check, an uptime bar and a response-time line. */
function ProjectHealthCard({ project: p, checks, series, now }: { project: Project; checks: HealthCheck[]; series: AllSeries | null; now: number }) {
  const sorted = [...checks].sort(
    (a, b) => Number(!a.enabled) - Number(!b.enabled) || SEVERITY[a.status] - SEVERITY[b.status] || a.name.localeCompare(b.name),
  )
  const all = checks.filter((c) => c.enabled).flatMap((c) => series?.series[c.id] ?? [])
  const uptime = series ? uptimeOf(all) : null
  return (
    <Card className="p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <Link to={`/projects/${p.key}`} className="group flex min-w-0 items-center gap-2.5">
          <StatusDot status={p.health_status} />
          <span className="truncate text-base font-semibold text-zinc-50 group-hover:underline">{p.name}</span>
          {p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} job{p.failing_jobs === 1 ? '' : 's'} failing</Badge>}
        </Link>
        <div className="shrink-0 text-right">
          <div className="text-lg font-semibold text-zinc-50">{fmtPct(uptime)}</div>
          <div className="text-[11px] text-zinc-500">uptime, 24h</div>
        </div>
      </div>
      <div className="-mx-2 space-y-1">
        {sorted.map((c) => {
          const b = series?.series[c.id] ?? []
          const old = isStale(c, now)
          return (
            <Link key={c.id} to={`/checks/${c.id}`} aria-label={`Open check ${c.name}`} className="group block rounded-md px-2 py-2 transition hover:bg-zinc-800/40">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot status={c.enabled ? c.status : 'disabled'} />
                  <span className="truncate text-zinc-100 group-hover:underline">{c.name}</span>
                  {c.service_key && <span className="truncate text-xs text-zinc-500">{c.service_key}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-400">
                  {(c.status !== 'up' || !c.enabled) && <HealthBadge status={c.status} paused={!c.enabled} />}
                  {old && <Badge tone="amber">stale</Badge>}
                  {c.enabled && <span title="Last response time">{c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}</span>}
                  <span className="text-zinc-600">·</span>
                  <span className={cx(old && 'text-amber-300')} title={fmtTime(c.last_checked_at)}>{c.last_checked_at ? timeAgo(c.last_checked_at) : 'not yet'}</span>
                </span>
              </div>
              {series ? (
                <>
                  <UptimeBar buckets={b} windowSeconds={series.window_seconds} slots={48} height="h-5" paused={!c.enabled} />
                  <div className="mt-2">
                    <Sparkline buckets={b} windowSeconds={series.window_seconds} bucketSeconds={series.bucket_seconds} height={40} />
                  </div>
                </>
              ) : (
                <div className="h-5 rounded bg-zinc-800/60" />
              )}
            </Link>
          )
        })}
      </div>
      <div className="mt-3 flex justify-between text-[11px] text-zinc-500">
        <span>24 hours ago</span>
        <span>now</span>
      </div>
    </Card>
  )
}

function AttentionCard({ items, failed, noChecks }: { items: AttentionItem[]; failed: boolean; noChecks: boolean }) {
  if (items.length === 0) {
    // Never claim "all clear" when something failed to load or nothing is being watched.
    if (failed) {
      return <Card className="mb-6 px-4 py-3 text-sm text-zinc-400">Nothing needs attention in the parts that loaded, but some parts are unavailable.</Card>
    }
    if (noChecks) {
      return <Card className="mb-6 px-4 py-3 text-sm text-zinc-400">Nothing is being monitored yet. Add health checks to start watching your projects.</Card>
    }
    return (
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
        <StatusDot status="up" />
        All systems operational
      </div>
    )
  }
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">Needs attention · {items.length}</div>
      <ul className="divide-y divide-zinc-800/70">
        {items.slice(0, 8).map((i) => (
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
      {items.length > 8 && <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">…and {items.length - 8} more</div>}
    </Card>
  )
}

function BackupCard({ section }: { section: Section<BackupStatus> }) {
  const s = section.data
  return (
    <section>
      <h2 className="mb-2 font-medium text-zinc-200">Backups <span className="text-xs font-normal text-zinc-500">· whole instance, not filtered by project</span></h2>
      <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
        {!s ? (
          <span className="text-zinc-400">{section.error ? 'Backup status is unavailable right now.' : 'Loading…'}</span>
        ) : (
          <>
            <span className="flex items-center gap-2 text-zinc-200">
              <StatusDot status={s.running ? 'running' : s.state === 'ok' ? 'success' : s.state === 'stale' ? 'degraded' : s.state === 'failed' ? 'failed' : 'none'} />
              {backupLabel(s).text}
              {s.state === 'failed' && s.last_error && <span className="text-xs text-red-300">{s.last_error}</span>}
            </span>
            <span className="text-xs text-zinc-500">
              {s.last_success_at ? `Last success ${fmtTime(s.last_success_at)}` : 'No successful backup yet'}
              {' · '}
              <Link to="/backups" className="text-emerald-400 hover:underline">Open backups</Link>
            </span>
          </>
        )}
      </Card>
    </section>
  )
}

function Stat({ label, value, tone, sub, unavailable }: { label: string; value: number | string; tone?: 'red' | 'amber' | 'green'; sub?: string; unavailable?: boolean }) {
  const color = unavailable ? 'text-zinc-500' : tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'green' ? 'text-emerald-400' : 'text-zinc-100'
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold', color)}>{unavailable ? '—' : value}</div>
      <div className="mt-0.5 min-h-4 text-xs text-zinc-500">{unavailable ? 'Unavailable' : sub}</div>
    </Card>
  )
}
