import { useEffect, useState } from 'react'
import { type HealthCheck, type Project } from '../../api'
import { StatusDot, cx, timeAgo } from '../../ui'
import { uptimeOf } from '../charts'
import { fmtPct } from '../health'
import { type AllSeries, isStale, type AttentionItem } from './shared'

/** A full-screen, glanceable board for a second monitor: one big tile per project, red when something is wrong. */
export function TvBoard({ projects, byProject, series, unmonitoredCount, items, stale, updated, now, onExit }: {
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
            <div className="mt-1 text-sm text-zinc-400">
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
                      <span className="shrink-0 tabular-nums text-zinc-400">{c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}</span>
                    </li>
                  ))}
                  {cs.length > 4 && <li className="text-sm text-zinc-400">+{cs.length - 4} more</li>}
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
