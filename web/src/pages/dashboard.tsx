import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isAdmin, type AlertChannel, type AlertRecord, type BackupStatus, type HealthStatus, type HealthCheck, type Job, type Project, type Secret, type SeriesBucket } from '../api'
import { useAuth } from '../auth'
import { NavIcon } from '../icons'
import { Badge, Button, Card, Empty, PageHeader, Select, Spinner, StatusDot, cx, fmtTime, timeAgo } from '../ui'
import { backupLabel } from './backups'
import { fmtDuration, Sparkline, UptimeBar, uptimeOf } from './charts'
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
const RANGES = [
  { id: '24h', label: '24h', ago: '24 hours ago' },
  { id: '7d', label: '7d', ago: '7 days ago' },
  { id: '30d', label: '30d', ago: '30 days ago' },
] as const
type RangeId = (typeof RANGES)[number]['id']

/** Alert channels plus recent deliveries, admin only. */
interface AlertsStatus {
  channels: AlertChannel[]
  history: AlertRecord[]
}

/** A status change as returned by /api/checks/events. */
interface RecentEvent {
  id: number
  at: string
  from_status: HealthStatus
  to_status: HealthStatus
  message: string
  check_id: string
  check_name: string
  project_key: string
  project_name: string
}
const FILTER_KEY = 'rexus.dashboard.project'

function readStoredFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeFilter(key: string) {
  try {
    localStorage.setItem(FILTER_KEY, key)
  } catch {
    /* private mode: the URL still carries it */
  }
}

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
  const [events, loadEvents] = useSection<RecentEvent[]>()
  const [alertsStatus, loadAlerts] = useSection<AlertsStatus>()
  const [backup, loadBackup] = useSection<BackupStatus>()
  // Selected project key, '' = all my projects. Lives in the URL (?project=key, shareable) and falls back
  // to the last choice made in this browser.
  const [params, setParams] = useSearchParams()
  const rawFilter = params.get('project') ?? readStoredFilter()
  const tv = params.get('tv') === '1'
  const range: RangeId = RANGES.find((r) => r.id === params.get('range'))?.id ?? '24h'
  const rangeInfo = RANGES.find((r) => r.id === range)!
  const setParam = (name: string, value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (value) next.set(name, value)
      else next.delete(name)
      return next
    }, { replace: true })
  const setFilter = (key: string) => {
    storeFilter(key)
    setParam('project', key)
  }
  const setRange = (id: RangeId) => setParam('range', id === '24h' ? '' : id)
  const setTv = (on: boolean) => {
    setParam('tv', on ? '1' : '')
    try {
      if (on) void document.documentElement.requestFullscreen?.()
      else if (document.fullscreenElement) void document.exitFullscreen()
    } catch {
      /* fullscreen is optional */
    }
  }
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const calls: Promise<void>[] = [
      loadProjects(api<{ projects: Project[] }>('/api/projects').then((r) => r.projects)),
      loadChecks(api<{ checks: HealthCheck[] }>('/api/checks').then((r) => r.checks)),
      loadSeries(api<AllSeries>(`/api/checks/series?range=${range}`)),
      loadEvents(api<{ events: RecentEvent[] }>(`/api/checks/events?range=${range}`).then((r) => r.events)),
    ]
    if (meta?.modules.scheduler) calls.push(loadJobs(api<{ jobs: Job[] }>('/api/jobs').then((r) => r.jobs)))
    if (meta?.modules.vault) calls.push(loadSecrets(api<{ secrets: Secret[] }>('/api/secrets?expiring=30').then((r) => r.secrets)))
    if (showBackup) calls.push(loadBackup(api<BackupStatus>('/api/backups/status')))
    if (admin) {
      calls.push(loadAlerts(Promise.all([
        api<{ channels: AlertChannel[] }>('/api/alerts/channels'),
        api<{ alerts: AlertRecord[] }>('/api/alerts/history?limit=200'),
      ]).then(([c, h]) => ({ channels: c.channels, history: h.alerts }))))
    }
    await Promise.all(calls)
    setNow(Date.now())
    setRefreshing(false)
  }, [meta, admin, showBackup, range, loadProjects, loadChecks, loadSeries, loadEvents, loadAlerts, loadJobs, loadSecrets, loadBackup])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Nothing has answered yet.
  if (!projects.data && !projects.error && !checks.data && !checks.error) return <Spinner />

  // A remembered project that no longer exists (or isn't shared with me any more) means "all".
  const filter = !projects.data || projects.data.some((p) => p.key === rawFilter) ? rawFilter : ''
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
  if (events.error) failed.push('incidents')
  if (meta?.modules.scheduler && jobs.error) failed.push('jobs')
  if (meta?.modules.vault && secrets.error) failed.push('secrets')
  if (showBackup && backup.error) failed.push('backup status')
  if (admin && alertsStatus.error) failed.push('alert status')

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
    ...(alertsStatus.data ? failingChannels(alertsStatus.data) : []).map((ch): AttentionItem => ({
      id: `a${ch.id}`, tone: 'red', label: 'Alerts failing', title: ch.name, to: '/alerts',
      sub: 'Your last alert to this channel didn’t go through — you may miss real alerts',
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

  const times = [projects, checks, series, events, alertsStatus, jobs, secrets, backup].map((s) => s.at).filter((t): t is number => t != null)
  const updated = times.length ? Math.min(...times) : null

  const projectOptions = projects.data ? [...projects.data].sort((a, b) => a.name.localeCompare(b.name)) : []
  const shownProjects = projectOptions.filter((p) => !filter || p.key === filter)
  const byProject = new Map<string, HealthCheck[]>()
  for (const c of allChecks ?? []) byProject.set(c.project_id, [...(byProject.get(c.project_id) ?? []), c])
  const monitored = shownProjects
    .filter((p) => byProject.has(p.id))
    .sort((a, b) => SEVERITY[a.health_status] - SEVERITY[b.health_status] || a.name.localeCompare(b.name))
  const unmonitored = shownProjects.filter((p) => !byProject.has(p.id))

  if (tv) {
    return (
      <TvBoard
        projects={monitored}
        byProject={byProject}
        series={series.data}
        unmonitoredCount={unmonitored.length}
        items={items}
        stale={failed.length > 0}
        updated={updated}
        now={now}
        onExit={() => setTv(false)}
      />
    )
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={<LiveStatus updated={updated} refreshing={refreshing} stale={failed.length > 0} />}
        actions={
          <>
            <RangeSwitch value={range} onChange={setRange} />
            <Button variant="secondary" onClick={() => setTv(true)} aria-label="Open TV mode" title="Full-screen status board for a wall display">TV mode</Button>
            {projectOptions.length > 1 && (
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by project" className="w-48!">
                <option value="">All projects</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.key}>{p.name}</option>
                ))}
              </Select>
            )}
            <Button variant="secondary" onClick={refresh} disabled={refreshing} aria-label="Refresh now">
              <span className={cx('inline-flex', refreshing && 'animate-spin')}><NavIcon name="refresh" size={16} /></span>
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

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <HealthTile
          unavailable={!allChecks}
          total={enabled.length}
          healthy={healthy.length}
          down={down.length}
          degraded={degraded.length}
          unknown={unknown.length}
          stale={stale.length}
          paused={paused.length}
          to={items.length > 0 ? '#needs-attention' : '#project-health'}
        />
        {meta?.modules.scheduler && <Stat label="Failing jobs" to="/jobs" unavailable={!failingJobs} value={failingJobs?.length ?? 0} sub={failingJobs?.length ? 'View jobs' : 'All jobs passing'} tone={failingJobs?.length ? 'red' : undefined} />}
        {meta?.modules.vault && <Stat label="Keys expiring (30 days)" to="/vault" unavailable={!expiring} value={expiring?.length ?? 0} sub={expiring?.length ? 'View vault' : 'Nothing expiring'} tone={expiring?.length ? 'amber' : undefined} />}
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
            <div id="project-health" className="mb-6 grid scroll-mt-4 grid-cols-1 gap-4 xl:grid-cols-2">
              {monitored.map((p) => (
                <ProjectHealthCard key={p.id} project={p} checks={byProject.get(p.id) ?? []} series={series.data} now={now} range={rangeInfo} />
              ))}
            </div>
          ) : null}

          {unmonitored.length > 0 && (
            <Card className="mb-6 overflow-hidden">
              <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
                Not monitored yet · {unmonitored.length}
                <span className="ml-2 text-xs font-normal text-zinc-500">These projects have no health checks</span>
              </div>
              <ul className="divide-y divide-zinc-800/70">
                {unmonitored.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <Link to={`/projects/${p.key}`} className="truncate text-zinc-100 hover:underline">{p.name}</Link>
                    {admin ? (
                      <Link to={`/projects/${p.key}/checks/new`} className="shrink-0 text-xs text-emerald-400 hover:underline">+ Add a check</Link>
                    ) : (
                      <Link to={`/projects/${p.key}`} className="shrink-0 text-xs text-zinc-400 hover:underline">Open project</Link>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <IncidentsCard section={events} filter={filter} range={rangeInfo} />

      {(meta?.modules.scheduler || meta?.modules.vault) && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {meta?.modules.scheduler && <UpcomingJobsCard jobs={jobs.data ? inScope(jobs.data) : null} error={!!jobs.error} />}
          {meta?.modules.vault && <ExpiringKeysCard secrets={expiring} error={!!secrets.error} />}
        </div>
      )}

      {admin && <AlertStatusCard section={alertsStatus} />}

      {showBackup && <BackupCard section={backup} />}
    </>
  )
}

/** One project: its 24h uptime and, per check, an uptime bar and a response-time line. */
function ProjectHealthCard({ project: p, checks, series, now, range }: { project: Project; checks: HealthCheck[]; series: AllSeries | null; now: number; range: (typeof RANGES)[number] }) {
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
          <div className="text-[11px] text-zinc-500">uptime, {range.label}</div>
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
                // One chart: response-time line with its status strip directly underneath as the x-axis.
                <div className={cx(!c.enabled && 'opacity-60')}>
                  <Sparkline buckets={b} windowSeconds={series.window_seconds} bucketSeconds={series.bucket_seconds} height={36} />
                  <div className="mt-1">
                    <UptimeBar buckets={b} windowSeconds={series.window_seconds} slots={48} height="h-2" paused={!c.enabled} />
                  </div>
                </div>
              ) : (
                <div className="h-11 rounded bg-zinc-800/60" />
              )}
            </Link>
          )
        })}
      </div>
      <div className="mt-3 flex justify-between text-[11px] text-zinc-500">
        <span>{range.ago}</span>
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
    <div id="needs-attention" className="scroll-mt-4">
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
    </div>
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

const TILE_LINK = 'block transition hover:border-zinc-700 hover:bg-zinc-800/40 focus-visible:outline-2'

/** Scrolls to an on-page section for "#id" targets, otherwise navigates. */
function TileLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  if (to.startsWith('#')) {
    return (
      <a
        href={to}
        className={className}
        onClick={(e) => {
          e.preventDefault()
          document.getElementById(to.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
      >
        {children}
      </a>
    )
  }
  return <Link to={to} className={className}>{children}</Link>
}

function Stat({ label, value, tone, sub, unavailable, to }: { label: string; value: number | string; tone?: 'red' | 'amber' | 'green'; sub?: string; unavailable?: boolean; to?: string }) {
  const color = unavailable ? 'text-zinc-500' : tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'green' ? 'text-emerald-400' : 'text-zinc-100'
  const body = (
    <Card className={cx('h-full px-4 py-3', to && TILE_LINK)}>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold', color)}>{unavailable ? '—' : value}</div>
      <div className="mt-0.5 min-h-4 text-xs text-zinc-500">{unavailable ? 'Unavailable' : sub}</div>
    </Card>
  )
  return to && !unavailable ? <TileLink to={to} className="block rounded-lg">{body}</TileLink> : body
}

/**
 * One tile for every check state: the big number is "healthy / active", a proportion bar shows the
 * split, and the chips name each non-healthy state with its count.
 */
function HealthTile({ unavailable, total, healthy, down, degraded, unknown, stale, paused, to }: {
  unavailable: boolean; total: number; healthy: number; down: number; degraded: number; unknown: number; stale: number; paused: number; to: string
}) {
  const other = Math.max(0, total - healthy - down - degraded)
  const allGood = total > 0 && healthy === total
  const tone = unavailable ? 'text-zinc-500' : down ? 'text-red-400' : degraded ? 'text-amber-300' : allGood ? 'text-emerald-400' : 'text-zinc-100'
  const chips: { label: string; n: number; cls: string }[] = [
    { label: 'down', n: down, cls: 'bg-red-950 text-red-300 border-red-900' },
    { label: 'degraded', n: degraded, cls: 'bg-amber-950 text-amber-300 border-amber-900' },
    { label: 'unknown', n: unknown, cls: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
    { label: 'stale', n: stale, cls: 'bg-amber-950 text-amber-300 border-amber-900' },
    { label: 'paused', n: paused, cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
  ].filter((c) => c.n > 0)
  const seg = (n: number, color: string) => (n > 0 ? <div style={{ width: `${(n / total) * 100}%`, background: color }} /> : null)
  const body = (
    <Card className={cx('h-full px-4 py-3', !unavailable && TILE_LINK)}>
      <div className="text-xs text-zinc-400">Health</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx('text-2xl font-semibold', tone)}>{unavailable ? '—' : `${healthy}/${total}`}</span>
        <span className="text-xs text-zinc-500">{unavailable ? 'Unavailable' : total === 0 ? 'No active checks' : 'checks healthy'}</span>
      </div>
      {!unavailable && total > 0 && (
        <div className="mt-2 flex h-1.5 gap-px overflow-hidden rounded-full bg-zinc-800" role="img" aria-label={`${healthy} healthy, ${degraded} degraded, ${down} down, ${other} other`}>
          {seg(healthy, 'var(--st-up)')}
          {seg(degraded, 'var(--st-degraded)')}
          {seg(down, 'var(--st-down)')}
          {seg(other, 'var(--st-none)')}
        </div>
      )}
      <div className="mt-2 flex min-h-5 flex-wrap gap-1.5">
        {!unavailable && chips.length === 0 && total > 0 && <span className="text-xs text-zinc-500">All reporting</span>}
        {chips.map((c) => (
          <span key={c.label} className={cx('inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', c.cls)}>{c.n} {c.label}</span>
        ))}
      </div>
    </Card>
  )
  return unavailable ? body : <TileLink to={to} className="col-span-2 block rounded-lg">{body}</TileLink>
}

/** "Updated 12s ago · auto-refresh every 30s" with a live dot: pulses while loading, amber when something failed. */
function LiveStatus({ updated, refreshing, stale }: { updated: number | null; refreshing: boolean; stale: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cx('inline-block h-2 w-2 rounded-full', stale ? 'bg-amber-400' : 'bg-emerald-400', refreshing && 'animate-pulse')} aria-hidden="true" />
      <span>
        {refreshing ? 'Refreshing…' : updated ? `Updated ${timeAgo(new Date(updated).toISOString())}` : 'Not updated yet'}
        <span className="text-zinc-500"> · auto-refresh every {REFRESH_MS / 1000}s</span>
      </span>
    </span>
  )
}

/** 24h / 7d / 30d, driving both the uptime charts and the incident list. */
function RangeSwitch({ value, onChange }: { value: RangeId; onChange: (r: RangeId) => void }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onChange(r.id)}
          aria-pressed={value === r.id}
          className={cx('rounded px-3 py-1.5 text-sm transition', value === r.id ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

interface Incident {
  key: string
  checkId: string
  checkName: string
  projectKey: string
  projectName: string
  tone: 'red' | 'amber'
  start: string | null // null: it began before the selected range
  end: string | null // null: still going
  message: string
}

/** Pairs status changes into incidents: from the first move away from "up" until the check is "up" again. */
function toIncidents(events: RecentEvent[]): Incident[] {
  const byCheck = new Map<string, RecentEvent[]>()
  for (const e of [...events].reverse()) byCheck.set(e.check_id, [...(byCheck.get(e.check_id) ?? []), e]) // oldest first
  const out: Incident[] = []
  for (const list of byCheck.values()) {
    let open: Incident | null = null
    for (const e of list) {
      const bad = e.to_status === 'down' || e.to_status === 'degraded'
      const base = { checkId: e.check_id, checkName: e.check_name, projectKey: e.project_key, projectName: e.project_name }
      if (bad && !open) {
        open = { ...base, key: `${e.id}`, tone: e.to_status === 'down' ? 'red' : 'amber', start: e.at, end: null, message: e.message }
      } else if (bad && open && e.to_status === 'down' && open.tone !== 'red') {
        open.tone = 'red'
        open.message = e.message
      } else if (e.to_status === 'up') {
        if (open) {
          out.push({ ...open, end: e.at })
          open = null
        } else if (e.from_status === 'down' || e.from_status === 'degraded') {
          out.push({ ...base, key: `${e.id}`, tone: e.from_status === 'down' ? 'red' : 'amber', start: null, end: e.at, message: '' })
        }
      }
    }
    if (open) out.push(open)
  }
  return out.sort((a, b) => new Date(b.end ?? new Date()).getTime() - new Date(a.end ?? new Date()).getTime() || new Date(b.start ?? 0).getTime() - new Date(a.start ?? 0).getTime())
}

function IncidentsCard({ section, filter, range }: { section: Section<RecentEvent[]>; filter: string; range: (typeof RANGES)[number] }) {
  const [all, setAll] = useState(false)
  if (!section.data) {
    return section.error ? <Card className="mb-6 px-4 py-3 text-sm text-zinc-400">Incident history is unavailable right now.</Card> : null
  }
  const incidents = toIncidents(filter ? section.data.filter((e) => e.project_key === filter) : section.data)
  const title = `Incidents · last ${range.label}`
  if (incidents.length === 0) {
    return (
      <Card className="mb-6 flex items-center gap-2.5 px-4 py-3 text-sm text-zinc-400">
        <StatusDot status="up" />
        No incidents in the last {range.label === '24h' ? '24 hours' : range.label === '7d' ? '7 days' : '30 days'}
      </Card>
    )
  }
  const shown = all ? incidents : incidents.slice(0, 6)
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
        {title} <span className="text-zinc-500">· {incidents.length}</span>
      </div>
      <ul className="divide-y divide-zinc-800/70">
        {shown.map((i) => {
          const dur = i.start ? fmtDuration((i.end ? new Date(i.end) : new Date()).getTime() - new Date(i.start).getTime()) : null
          return (
            <li key={i.key}>
              <Link to={`/checks/${i.checkId}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Badge tone={i.tone}>{i.tone === 'red' ? 'Down' : 'Degraded'}</Badge>
                  <span className="min-w-0">
                    <span className="text-zinc-100">{i.checkName}</span>
                    <span className="ml-2 text-xs text-zinc-500">{i.projectName}{i.message ? ` · ${i.message}` : ''}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-400">
                  {i.end === null && <Badge tone="red">Ongoing</Badge>}
                  <span title={i.start ? fmtTime(i.start) : undefined}>
                    {i.start ? timeAgo(i.start) : `before ${range.label}`}
                    {i.end ? ` → recovered ${timeAgo(i.end)}` : ''}
                  </span>
                  {dur && <span className="text-zinc-500">· {dur}</span>}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {incidents.length > 6 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-zinc-800 px-4 py-2 text-left text-xs text-zinc-400 hover:text-zinc-200">
          {all ? 'Show fewer' : `Show ${incidents.length - 6} more`}
        </button>
      )}
    </Card>
  )
}

// ───────────────────────── jobs, keys, alert channels ─────────────────────────

function ListCard({ title, count, to, toLabel, children }: { title: string; count?: number; to: string; toLabel: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
        <span className="text-sm font-medium text-zinc-200">
          {title}{count != null && <span className="text-zinc-500"> · {count}</span>}
        </span>
        <Link to={to} className="text-xs text-emerald-400 hover:underline">{toLabel}</Link>
      </div>
      {children}
    </Card>
  )
}

function UpcomingJobsCard({ jobs, error }: { jobs: Job[] | null; error: boolean }) {
  if (!jobs) return <Card className="px-4 py-3 text-sm text-zinc-400">{error ? 'Jobs are unavailable right now.' : 'Loading jobs…'}</Card>
  const active = jobs.filter((j) => j.enabled)
  const next = [...active].sort((a, b) => new Date(a.next_run_at ?? 8.64e15).getTime() - new Date(b.next_run_at ?? 8.64e15).getTime()).slice(0, 5)
  return (
    <ListCard title="Next job runs" count={active.length} to="/jobs" toLabel="All pings">
      {next.length === 0 ? (
        <div className="px-4 py-3 text-sm text-zinc-500">{jobs.length === 0 ? 'No jobs yet.' : 'All jobs are paused.'}</div>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {next.map((j) => (
            <li key={j.id}>
              <Link to={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot status={j.last_status} />
                  <span className="truncate text-zinc-100">{j.name}</span>
                  <span className="truncate text-xs text-zinc-500">{scopeName(j)}</span>
                  {j.last_status === 'failed' && <Badge tone="red">failing</Badge>}
                </span>
                <span className="shrink-0 text-xs text-zinc-400" title={j.next_run_at ? fmtTime(j.next_run_at) : undefined}>
                  {j.next_run_at ? timeAgo(j.next_run_at) : '—'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  )
}

function ExpiringKeysCard({ secrets, error }: { secrets: Secret[] | null; error: boolean }) {
  if (!secrets) return <Card className="px-4 py-3 text-sm text-zinc-400">{error ? 'Keys are unavailable right now.' : 'Loading keys…'}</Card>
  const soonest = [...secrets].sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999)).slice(0, 5)
  return (
    <ListCard title="Keys expiring soon" count={secrets.length} to="/vault" toLabel="Open vault">
      {soonest.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-500"><StatusDot status="up" />No keys expire in the next 30 days.</div>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {soonest.map((k) => (
            <li key={k.id}>
              <Link to={`/projects/${k.project_key}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                <span className="min-w-0">
                  <span className="text-zinc-100">{k.name}</span>
                  <span className="ml-2 text-xs text-zinc-500">{scopeName(k)} · {k.environment}</span>
                </span>
                <ExpiryBadge secret={k} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  )
}

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', email: 'Email' }

/** The most recent delivery attempt (alert or test) to each channel, by channel name. */
function lastDelivery(history: AlertRecord[], channelName: string): AlertRecord | undefined {
  return history.find((h) => h.channel_name === channelName) // history is newest first
}

/** Enabled channels whose latest delivery failed. */
function failingChannels(a: AlertsStatus): AlertChannel[] {
  return a.channels.filter((c) => c.enabled && lastDelivery(a.history, c.name)?.status === 'failed')
}

function AlertStatusCard({ section }: { section: Section<AlertsStatus> }) {
  const a = section.data
  if (!a) return <Card className="mb-6 px-4 py-3 text-sm text-zinc-400">{section.error ? 'Alert channel status is unavailable right now.' : 'Loading alert channels…'}</Card>
  const active = a.channels.filter((c) => c.enabled)
  const failing = failingChannels(a)
  const problem = a.channels.length === 0 ? 'No alert channels are set up — nobody gets notified when something breaks.' : active.length === 0 ? 'All alert channels are switched off — nobody gets notified.' : null
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <StatusDot status={problem ? 'degraded' : failing.length ? 'down' : 'up'} />
          Alert channels <span className="text-zinc-500">· {active.length} active</span>
        </span>
        <Link to="/alerts" className="text-xs text-emerald-400 hover:underline">Manage alerts</Link>
      </div>
      {problem ? (
        <div className="px-4 py-3 text-sm text-amber-300">
          {problem} <Link to="/alerts" className="text-emerald-400 hover:underline">Set up alerts</Link>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {a.channels.slice(0, 6).map((c) => {
            const d = lastDelivery(a.history, c.name)
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge>{CHANNEL_LABEL[c.type] ?? c.type}</Badge>
                  <span className="truncate text-zinc-100">{c.name}</span>
                  {!c.enabled && <Badge>off</Badge>}
                </span>
                <span className="text-xs">
                  {!d ? (
                    <span className="text-zinc-500">nothing sent yet — <Link to="/alerts" className="text-emerald-400 hover:underline">send a test</Link></span>
                  ) : d.status === 'sent' ? (
                    <span className="text-zinc-400" title={fmtTime(d.at)}><span className="text-emerald-400">✓ delivered</span> {timeAgo(d.at)}{d.event === 'test' ? ' (test)' : ''}</span>
                  ) : (
                    <span className="text-red-300" title={fmtTime(d.at)}>✕ failed {timeAgo(d.at)}{d.error ? ` · ${d.error}` : ''}</span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// ───────────────────────── TV / wall mode ─────────────────────────

/** A full-screen, glanceable board for a second monitor: one big tile per project, red when something is wrong. */
function TvBoard({ projects, byProject, series, unmonitoredCount, items, stale, updated, now, onExit }: {
  projects: Project[]
  byProject: Map<string, HealthCheck[]>
  series: AllSeries | null
  unmonitoredCount: number
  items: AttentionItem[]
  stale: boolean
  updated: number | null
  now: number
  onExit: () => void
}) {
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onExit()
    window.addEventListener('keydown', esc)
    return () => {
      clearInterval(t)
      window.removeEventListener('keydown', esc)
    }
  }, [onExit])

  const bad = items.filter((i) => i.tone === 'red').length
  const warn = items.length - bad
  const tone = bad ? 'red' : warn ? 'amber' : 'green'
  const banner = bad ? `${bad} ${bad === 1 ? 'issue needs' : 'issues need'} attention` : warn ? `${warn} ${warn === 1 ? 'warning' : 'warnings'}` : 'All systems operational'
  const ring = { red: 'border-red-500/50 bg-red-500/10 text-red-300', amber: 'border-amber-500/50 bg-amber-500/10 text-amber-200', green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }[tone]

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-zinc-950 p-6 sm:p-10">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className={cx('flex items-center gap-4 rounded-2xl border px-6 py-4 text-3xl font-semibold sm:text-5xl', ring)}>
            <span className={cx('inline-block h-4 w-4 rounded-full sm:h-6 sm:w-6', tone === 'red' ? 'bg-red-400' : tone === 'amber' ? 'bg-amber-400' : 'bg-emerald-400')} aria-hidden="true" />
            {banner}
          </div>
          <div className="text-right">
            <div className="text-4xl font-semibold tabular-nums text-zinc-100 sm:text-6xl">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="mt-1 text-sm text-zinc-500">
              {stale ? 'Some data may be out of date · ' : ''}
              {updated ? `updated ${timeAgo(new Date(updated).toISOString())}` : 'not updated yet'}
            </div>
            <button type="button" onClick={onExit} className="mt-2 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">Exit · Esc</button>
          </div>
        </div>

        {items.length > 0 && (
          <ul className="grid gap-3 lg:grid-cols-2">
            {items.slice(0, 6).map((i) => (
              <li key={i.id} className={cx('rounded-xl border px-5 py-3 text-lg', i.tone === 'red' ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-100')}>
                <span className="font-semibold">{i.label}</span> · {i.title}
                <div className="truncate text-sm opacity-70">{i.sub}</div>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {projects.map((p) => {
            const cs = (byProject.get(p.id) ?? []).filter((c) => c.enabled)
            const downN = cs.filter((c) => c.status === 'down').length
            const degN = cs.filter((c) => c.status === 'degraded').length
            const projTone = p.failing_jobs > 0 || downN ? 'red' : degN || cs.some((c) => isStale(c, now)) ? 'amber' : 'green'
            const uptime = series ? uptimeOf(cs.flatMap((c) => series.series[c.id] ?? [])) : null
            return (
              <div
                key={p.id}
                className={cx('rounded-2xl border p-6', projTone === 'red' ? 'border-red-500/50 bg-red-500/10' : projTone === 'amber' ? 'border-amber-500/40 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/60')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3 text-2xl font-semibold text-zinc-50">
                    <StatusDot status={p.health_status} />
                    <span className="truncate">{p.name}</span>
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-zinc-100">{fmtPct(uptime)}</div>
                </div>
                <div className="mt-3 text-lg text-zinc-400">
                  {downN ? <span className="text-red-300">{downN} down</span> : null}
                  {downN && degN ? ' · ' : null}
                  {degN ? <span className="text-amber-300">{degN} degraded</span> : null}
                  {!downN && !degN ? `${cs.length} ${cs.length === 1 ? 'check' : 'checks'} healthy` : null}
                  {p.failing_jobs > 0 ? <span className="text-red-300"> · {p.failing_jobs} job{p.failing_jobs === 1 ? '' : 's'} failing</span> : null}
                </div>
                <ul className="mt-4 space-y-1.5 text-base text-zinc-300">
                  {cs.slice(0, 4).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2"><StatusDot status={c.status} /><span className="truncate">{c.name}</span></span>
                      <span className="shrink-0 tabular-nums text-zinc-500">{c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}</span>
                    </li>
                  ))}
                  {cs.length > 4 && <li className="text-sm text-zinc-500">+{cs.length - 4} more</li>}
                </ul>
              </div>
            )
          })}
        </div>
        {unmonitoredCount > 0 && <div className="text-sm text-zinc-600">{unmonitoredCount} project{unmonitoredCount === 1 ? '' : 's'} without health checks not shown</div>}
      </div>
    </div>
  )
}
