import { Link } from 'react-router-dom'
import { type HealthCheck, type Project } from '../../api'
import { Badge, Card, StatusDot, WebsiteLink, cx, fmtTime, hostOf, timeAgo } from '../../ui'
import { Sparkline, UptimeBar, uptimeOf } from '../charts'
import { fmtPct, HealthBadge } from '../health'
import { type AllSeries, RANGES, isStale, SEVERITY } from './shared'

/** One project: its 24h uptime and, per check, an uptime bar and a response-time line. */
export function ProjectHealthCard({ project: p, checks, series, now, range }: { project: Project; checks: HealthCheck[]; series: AllSeries | null; now: number; range: (typeof RANGES)[number] }) {
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
          <div className="text-lg font-semibold tabular-nums text-zinc-50">{fmtPct(uptime)}</div>
          <div className="text-xs text-zinc-400">uptime, {range.label}</div>
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
                  {c.service_key && <span className="truncate text-xs text-zinc-400">{c.service_key}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-zinc-400">
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
                <div className="h-11 animate-pulse rounded bg-zinc-800/60" />
              )}
            </Link>
          )
        })}
      </div>
      <div className="mt-3 flex justify-between text-xs text-zinc-400">
        <span>{range.ago}</span>
        <span>now</span>
      </div>
    </Card>
  )
}
