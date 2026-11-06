import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isAdmin, type AlertChannel, type AlertRecord, type BackupStatus, type HealthCheck, type Job, type Project, type Secret } from '../../api'
import { useAuth } from '../../auth'
import { NavIcon } from '../../icons'
import { Button, Card, Empty, PageHeader, Select, cx, timeAgo } from '../../ui'
import { fmtDuration, responseStats, uptimeOf } from '../charts'
import { degradedReason, fmtPct } from '../health'
import { ExpiryBadge } from '../vault'
import { useSection, type AllSeries, REFRESH_MS, RANGES, type RangeId, type AlertsStatus, type RecentEvent, readStoredFilter, storeFilter, isStale, scopeName, SEVERITY, type AttentionItem } from './shared'
import { ProjectGrid } from './project_grid'
import { AttentionPanel } from './attention'
import { Stat, HealthTile } from './tiles'
import { LiveStatus, RangeSwitch } from './header'
import { toIncidents, IncidentsPanel } from './incidents'
import { OperationsPanel, failingChannels, alertsProblem } from './operations'
import { TvBoard } from './tv_board'
import { DashboardSkeleton } from './skeleton'

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
  if (!projects.data && !projects.error && !checks.data && !checks.error) return <DashboardSkeleton />

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

  // True until every section that feeds "Needs attention" has answered (or failed), so the list doesn't pop in late.
  const attentionLoading = [checks, events, ...(meta?.modules.scheduler ? [jobs] : []), ...(meta?.modules.vault ? [secrets] : []), ...(admin ? [alertsStatus] : [])].some((s) => !s.data && !s.error)

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
    ...(alertsStatus.data && alertsProblem(alertsStatus.data) ? [alertsProblem(alertsStatus.data)!] : []).map((problem): AttentionItem => ({
      id: 'a-none', tone: 'amber', label: 'No alerts', title: problem, to: '/alerts',
      sub: 'Nobody gets notified when something breaks',
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
          loading={!series.data && !series.error}
          unavailable={!series.data || !allChecks}
          value={fmtPct(uptime)}
          tone={uptime == null ? undefined : uptime >= 99.9 ? 'green' : uptime >= 99 ? 'amber' : 'red'}
          sub={uptimeSub}
          subTone={partial ? 'amber' : undefined}
        />
        <HealthTile
          loading={!allChecks && !checks.error}
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
          loading={!series.data && !series.error}
          unavailable={!series.data || !allChecks}
          value={resp?.avg != null ? `${resp.avg} ms` : '—'}
          sub={resp?.avg != null ? `Range ${resp.min}–${resp.max} ms` : enabled.length === 0 ? 'No active checks' : 'No results yet'}
        />
        <Stat
          label={`Incidents · ${rangeInfo.label}`}
          loading={!incidents && !events.error}
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
                <div id="project-health" className="scroll-mt-4">
                  <ProjectGrid projects={monitored} byProject={byProject} series={series.data} now={now} range={rangeInfo} canEdit={admin} />
                </div>
              )}

              {unmonitored.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
                    Not monitored yet · {unmonitored.length}
                    <span className="ml-2 text-xs font-normal text-zinc-400">These projects have no health checks</span>
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
          <AttentionPanel loading={attentionLoading} items={items} failed={failed.length > 0} noChecks={!!allChecks && enabled.length === 0} />
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
