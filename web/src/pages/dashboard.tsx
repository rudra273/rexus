import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isAdmin, type AlertChannel, type AlertRecord, type BackupStatus, type HealthStatus, type HealthCheck, type Job, type Project, type Secret, type SeriesBucket } from '../api'
import { useAuth } from '../auth'
import { NavIcon } from '../icons'
import { Badge, Button, Card, Empty, PageHeader, Select, Spinner, StatusDot, WebsiteLink, cx, fmtTime, hostOf, timeAgo } from '../ui'
import { backupLabel } from './backups'
import { fmtDuration, responseStats, Sparkline, UptimeBar, uptimeOf } from './charts'
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
  { id: '24h', label: '24h', words: '24 hours', ago: '24 hours ago' },
  { id: '7d', label: '7d', words: '7 days', ago: '7 days ago' },
  { id: '30d', label: '30d', words: '30 days', ago: '30 days ago' },
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

  // Summary tiles. All of them follow the selected range.
  const incidents = events.data ? toIncidents(filter ? events.data.filter((e) => e.project_key === filter) : events.data) : null
  const ongoing = incidents?.filter((i) => i.end === null).length ?? 0
  const buckets = series.data ? enabled.flatMap((c) => series.data?.series[c.id] ?? []) : []
  const uptime = uptimeOf(buckets)
  const resp = responseStats(buckets)
  // "Partial": the oldest result is much newer than the start of the range, so the % covers only part of it.
  const coverageMs = buckets.length ? now - Math.min(...buckets.map((b) => new Date(b.t).getTime())) : null
  const partial = !!series.data && coverageMs != null && coverageMs < series.data.window_seconds * 1000 * 0.95
  const uptimeSub = enabled.length === 0 ? 'No active checks' : uptime == null ? 'No results yet' : partial ? `Partial · ${fmtDuration(coverageMs ?? 0)} of ${rangeInfo.label} recorded` : 'All checks combined'

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
            <Button variant="secondary" onClick={() => setTv(true)} aria-label="Open TV mode" title="TV mode: full-screen status board for a wall display" className="px-2.5">
              <NavIcon name="tv" size={18} />
            </Button>
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
        <Stat
          label={`Uptime · ${rangeInfo.label}`}
          unavailable={!series.data || !allChecks}
          value={fmtPct(uptime)}
          tone={uptime == null ? undefined : uptime >= 99.9 ? 'green' : uptime >= 99 ? 'amber' : 'red'}
          sub={uptimeSub}
          subTone={partial ? 'amber' : undefined}
        />
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
        <Stat
          label={`Avg response · ${rangeInfo.label}`}
          unavailable={!series.data || !allChecks}
          value={resp?.avg != null ? `${resp.avg} ms` : '—'}
          sub={resp?.avg != null ? `Range ${resp.min}–${resp.max} ms` : enabled.length === 0 ? 'No active checks' : 'No results yet'}
        />
        <Stat
          label={`Incidents · ${rangeInfo.label}`}
          unavailable={!incidents}
          value={incidents?.length ?? 0}
          tone={ongoing > 0 ? 'red' : undefined}
          sub={ongoing > 0 ? `${ongoing} ongoing` : incidents?.length ? 'All recovered' : 'None recorded'}
          to={incidents?.length ? '#incidents' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
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
          ) : !allChecks ? (
            <Card className="px-4 py-3 text-sm text-zinc-400">Health checks are unavailable right now.</Card>
          ) : (
            <>
              {monitored.length > 0 && (
                <div id="project-health" className="grid scroll-mt-4 grid-cols-1 gap-4">
                  {monitored.map((p) => (
                    <ProjectHealthCard key={p.id} project={p} checks={byProject.get(p.id) ?? []} series={series.data} now={now} range={rangeInfo} />
                  ))}
                </div>
              )}

              {unmonitored.length > 0 && (
                <Card className="overflow-hidden">
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
        </div>

        <aside aria-label="Status and operations" className="min-w-0 space-y-4">
          <AttentionPanel items={items} failed={failed.length > 0} noChecks={!!allChecks && enabled.length === 0} />
          <IncidentsPanel incidents={incidents} error={!!events.error} range={rangeInfo} />
          <OperationsPanel
            jobs={meta?.modules.scheduler ? { data: jobs.data ? inScope(jobs.data) : null, error: !!jobs.error } : undefined}
            keys={meta?.modules.vault ? { data: expiring, error: !!secrets.error } : undefined}
            alerts={admin ? alertsStatus : undefined}
            backup={showBackup ? backup : undefined}
          />
        </aside>
      </div>
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
        <div className="flex min-w-0 items-center gap-1.5">
        <Link to={`/projects/${p.key}`} className="group flex min-w-0 items-center gap-2.5">
          <StatusDot status={p.health_status} />
          <span className="truncate text-base font-semibold text-zinc-50 group-hover:underline">{p.name}</span>
          {p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} job{p.failing_jobs === 1 ? '' : 's'} failing</Badge>}
        </Link>
        {p.website_url && <WebsiteLink url={p.website_url} title={`Open ${hostOf(p.website_url)}`} className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800" />}
        </div>
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

function AttentionPanel({ items, failed, noChecks }: { items: AttentionItem[]; failed: boolean; noChecks: boolean }) {
  if (items.length === 0) {
    // Never claim "all clear" when something failed to load or nothing is being watched.
    const [dot, text]: ['up' | 'degraded' | 'none', string] = failed
      ? ['degraded', 'Nothing needs attention in the parts that loaded, but some parts are unavailable.']
      : noChecks
        ? ['none', 'Nothing is being monitored yet. Add health checks to start watching your projects.']
        : ['up', 'All systems operational']
    return (
      <div id="needs-attention" className="scroll-mt-4">
        <Card className="flex items-start gap-2.5 px-4 py-3 text-sm text-zinc-200">
          <span className="mt-1.5"><StatusDot status={dot} /></span>
          <span role="status">{text}</span>
        </Card>
      </div>
    )
  }
  return (
    <div id="needs-attention" className="scroll-mt-4">
      <Card className="overflow-hidden">
        <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
          Needs attention <span className="text-zinc-400">· {items.length}</span>
        </div>
        <ul className="divide-y divide-zinc-800/70">
          {items.slice(0, 6).map((i) => (
            <li key={i.id}>
              <Link to={i.to} className="block px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={i.tone}>{i.label}</Badge>
                    <span className="truncate text-zinc-100">{i.title}</span>
                  </span>
                  {i.right}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-zinc-400" title={i.sub}>{i.sub}</div>
              </Link>
            </li>
          ))}
        </ul>
        {items.length > 6 && <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400">…and {items.length - 6} more</div>}
      </Card>
    </div>
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

function Stat({ label, value, tone, sub, subTone, unavailable, to }: { label: string; value: number | string; tone?: 'red' | 'amber' | 'green'; sub?: string; subTone?: 'amber'; unavailable?: boolean; to?: string }) {
  const color = unavailable ? 'text-zinc-500' : tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'green' ? 'text-emerald-400' : 'text-zinc-100'
  const body = (
    <Card className={cx('h-full px-4 py-3', to && TILE_LINK)}>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', color)}>{unavailable ? '—' : value}</div>
      <div className={cx('mt-0.5 min-h-4 text-xs', subTone === 'amber' && !unavailable ? 'text-amber-300' : 'text-zinc-400')}>{unavailable ? 'Unavailable' : sub}</div>
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
      <div className="text-xs text-zinc-400">Checks healthy</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx('text-2xl font-semibold tabular-nums', tone)}>{unavailable ? '—' : `${healthy}/${total}`}</span>
        <span className="text-xs text-zinc-500">{unavailable ? 'Unavailable' : total === 0 ? 'No active checks' : ''}</span>
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
  return unavailable ? body : <TileLink to={to} className="block rounded-lg">{body}</TileLink>
}

/** "Updated 12s ago · auto-refresh every 30s" with a live dot: pulses while loading, amber when something failed. */
function LiveStatus({ updated, refreshing, stale }: { updated: number | null; refreshing: boolean; stale: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="inline-flex items-center gap-2" title={`Refreshes automatically every ${REFRESH_MS / 1000} seconds`}>
      <span className={cx('inline-block h-2 w-2 rounded-full', stale ? 'bg-amber-400' : 'bg-emerald-400', refreshing && 'animate-pulse')} aria-hidden="true" />
      <span>
        {refreshing ? 'Refreshing…' : updated ? `Updated ${timeAgo(new Date(updated).toISOString())}` : 'Not updated yet'}
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

function IncidentsPanel({ incidents, error, range }: { incidents: Incident[] | null; error: boolean; range: (typeof RANGES)[number] }) {
  const [all, setAll] = useState(false)
  let body: ReactNode
  if (!incidents) {
    if (!error) return null
    body = <Card className="px-4 py-3 text-sm text-zinc-400">Incident history is unavailable right now.</Card>
  } else if (incidents.length === 0) {
    body = (
      <Card className="flex items-center gap-2.5 px-4 py-3 text-sm text-zinc-300">
        <StatusDot status="up" />
        No incidents in the last {range.words}
      </Card>
    )
  } else {
    const shown = all ? incidents : incidents.slice(0, 4)
    body = (
      <Card className="overflow-hidden">
        <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
          Recent incidents <span className="text-zinc-400">· {incidents.length}</span>
        </div>
        <ul className="divide-y divide-zinc-800/70">
          {shown.map((i) => {
            const dur = i.start ? fmtDuration((i.end ? new Date(i.end) : new Date()).getTime() - new Date(i.start).getTime()) : null
            const when = `${i.start ? timeAgo(i.start) : `before ${range.label}`}${i.end ? ` · recovered ${timeAgo(i.end)}` : ''}`
            return (
              <li key={i.key}>
                <Link to={`/checks/${i.checkId}`} className="block px-4 py-2.5 text-sm hover:bg-zinc-800/30">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={i.tone}>{i.tone === 'red' ? 'Down' : 'Degraded'}</Badge>
                      <span className="truncate text-zinc-100">{i.checkName}</span>
                    </span>
                    {i.end === null ? <Badge tone="red">Ongoing</Badge> : dur && <span className="shrink-0 text-xs text-zinc-400">{dur}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-400" title={`${i.projectName} · ${when}${i.message ? ` · ${i.message}` : ''}`}>
                    {i.projectName} · {when}
                    {i.message ? ` · ${i.message}` : ''}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
        {incidents.length > 4 && (
          <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-zinc-800 px-4 py-2 text-left text-xs text-zinc-400 hover:text-zinc-200">
            {all ? 'Show fewer' : `Show ${incidents.length - 4} more`}
          </button>
        )}
      </Card>
    )
  }
  return <div id="incidents" className="scroll-mt-4">{body}</div>
}

// ───────────────────────── jobs, keys, alert channels ─────────────────────────

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', email: 'Email' }

/** The most recent delivery attempt (alert or test) to each channel, by channel name. */
function lastDelivery(history: AlertRecord[], channelName: string): AlertRecord | undefined {
  return history.find((h) => h.channel_name === channelName) // history is newest first
}

/** Enabled channels whose latest delivery failed. */
function failingChannels(a: AlertsStatus): AlertChannel[] {
  return a.channels.filter((c) => c.enabled && lastDelivery(a.history, c.name)?.status === 'failed')
}

type OpsTone = 'ok' | 'warn' | 'bad' | 'run' | 'none'
const OPS_DOT = { ok: 'up', warn: 'degraded', bad: 'down', run: 'running', none: 'none' } as const
const OPS_TEXT: Record<OpsTone, string> = { ok: 'text-zinc-400', warn: 'text-amber-300', bad: 'text-red-300', run: 'text-sky-300', none: 'text-zinc-400' }

interface OpsDetail {
  id: string
  to: string
  title: string
  sub?: string
  right?: ReactNode
}
interface OpsRow {
  id: string
  label: string
  hint?: string
  to: string
  tone: OpsTone
  summary: string
  details?: OpsDetail[]
}

/**
 * Jobs, keys, alert channels and backups in one card. Every row is a single line while healthy and only
 * grows a short list underneath when something needs a look.
 */
function OperationsPanel({ jobs, keys, alerts, backup }: {
  jobs?: { data: Job[] | null; error: boolean }
  keys?: { data: Secret[] | null; error: boolean }
  alerts?: Section<AlertsStatus>
  backup?: Section<BackupStatus>
}) {
  const rows: OpsRow[] = []
  const pending = (error: boolean) => (error ? 'Unavailable' : 'Loading…')

  if (jobs) {
    if (!jobs.data) {
      rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: pending(jobs.error) })
    } else {
      const active = jobs.data.filter((j) => j.enabled)
      const failing = active.filter((j) => j.last_status === 'failed')
      const times = active.flatMap((j) => (j.next_run_at ? [new Date(j.next_run_at).getTime()] : []))
      const next = times.length ? new Date(Math.min(...times)).toISOString() : null
      if (failing.length > 0) {
        rows.push({
          id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'bad', summary: `${failing.length} failing`,
          details: failing.map((j) => ({ id: j.id, to: `/jobs/${j.id}`, title: j.name, sub: scopeName(j), right: <span className="shrink-0 text-zinc-400">{j.last_run_at ? timeAgo(j.last_run_at) : ''}</span> })),
        })
      } else if (jobs.data.length === 0) {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: 'No jobs yet' })
      } else if (active.length === 0) {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: 'All paused' })
      } else {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'ok', summary: `${active.length} active${next ? ` · next run ${timeAgo(next)}` : ''}` })
      }
    }
  }

  if (keys) {
    if (!keys.data) {
      rows.push({ id: 'keys', label: 'Keys', to: '/vault', tone: 'none', summary: pending(keys.error) })
    } else if (keys.data.length === 0) {
      rows.push({ id: 'keys', label: 'Keys', to: '/vault', tone: 'ok', summary: 'None expiring in 30 days' })
    } else {
      const soonest = [...keys.data].sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999))
      rows.push({
        id: 'keys', label: 'Keys', to: '/vault', tone: (soonest[0].days_left ?? 9999) <= 7 ? 'bad' : 'warn',
        summary: `${soonest.length} expiring within 30 days`,
        details: soonest.map((k) => ({ id: k.id, to: `/projects/${k.project_key}`, title: k.name, sub: k.environment, right: <ExpiryBadge secret={k} /> })),
      })
    }
  }

  if (alerts) {
    const a = alerts.data
    if (!a) {
      rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'none', summary: pending(!!alerts.error) })
    } else {
      const active = a.channels.filter((c) => c.enabled)
      const failing = failingChannels(a)
      if (a.channels.length === 0) {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'warn', summary: 'None set up — nobody gets notified' })
      } else if (active.length === 0) {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'warn', summary: 'All off — nobody gets notified' })
      } else if (failing.length > 0) {
        rows.push({
          id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'bad', summary: `${failing.length} failing`,
          details: failing.map((c) => {
            const d = lastDelivery(a.history, c.name)
            return { id: c.id, to: '/alerts', title: c.name, sub: CHANNEL_LABEL[c.type] ?? c.type, right: <span className="shrink-0 text-zinc-400">{d ? `failed ${timeAgo(d.at)}` : ''}</span> }
          }),
        })
      } else {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'ok', summary: `${active.length} ${active.length === 1 ? 'channel' : 'channels'} active` })
      }
    }
  }

  if (backup) {
    const s = backup.data
    if (!s) {
      rows.push({ id: 'backups', label: 'Backups', hint: 'Whole instance, not filtered by project', to: '/backups', tone: 'none', summary: pending(!!backup.error) })
    } else {
      const l = backupLabel(s)
      const tone: OpsTone = l.tone === 'green' ? 'ok' : l.tone === 'amber' ? 'warn' : l.tone === 'red' ? 'bad' : 'run'
      rows.push({
        id: 'backups', label: 'Backups', hint: 'Whole instance, not filtered by project', to: '/backups', tone, summary: l.text,
        details: s.state === 'failed' && s.last_error ? [{ id: 'err', to: '/backups', title: s.last_error }] : undefined,
      })
    }
  }

  if (rows.length === 0) return null
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">Operations</div>
      <ul className="divide-y divide-zinc-800/70">
        {rows.map((r) => (
          <li key={r.id}>
            <Link to={r.to} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
              <StatusDot status={OPS_DOT[r.tone]} />
              <span className="shrink-0 font-medium text-zinc-100" title={r.hint}>{r.label}</span>
              <span className={cx('min-w-0 flex-1 truncate text-right text-xs', OPS_TEXT[r.tone])} title={r.summary}>{r.summary}</span>
            </Link>
            {r.details && (
              <ul className="pb-2">
                {r.details.slice(0, 3).map((d) => (
                  <li key={d.id}>
                    <Link to={d.to} className="flex items-center justify-between gap-2 py-1 pr-4 pl-10 text-xs hover:bg-zinc-800/30">
                      <span className="min-w-0 truncate text-zinc-300" title={d.title}>
                        {d.title}
                        {d.sub && <span className="ml-1.5 text-zinc-400">{d.sub}</span>}
                      </span>
                      {d.right}
                    </Link>
                  </li>
                ))}
                {r.details.length > 3 && <li className="py-1 pr-4 pl-10 text-xs text-zinc-400">+{r.details.length - 3} more</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
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
