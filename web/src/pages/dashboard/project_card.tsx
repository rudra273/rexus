import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { type HealthCheck, type Project } from '../../api'
import { NavIcon } from '../../icons'
import { Badge, Card, StatusDot, WebsiteLink, cx, fmtTime, hostOf, timeAgo } from '../../ui'
import { Sparkline, UptimeBar, uptimeOf } from '../charts'
import { fmtPct, HealthBadge } from '../health'
import { CARD_CHROME } from './layout'
import { type AllSeries, RANGES, isStale, SEVERITY } from './shared'

/** Cards narrower than this (px of content width) switch to compact rows by themselves. */
const AUTO_COMPACT_BELOW = 300
/** Under this width the per-check uptime % is dropped from compact rows to leave room for the strip. */
const HIDE_ROW_UPTIME_BELOW = 360
/** Compact cards list this many checks (worst first); the rest are summarised as "+N more". */
const COMPACT_MAX_ROWS = 6

/** Size of an element, kept up to date. Infinity until measured, so the first render uses the roomy layout. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: Infinity, height: Infinity })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/**
 * One project: its uptime and, per check, a response-time line with a history strip (comfortable), or a
 * single line with the strip only (compact). The whole card opens the project; each row opens its check.
 * On the project grid (`fill`) it fills its panel and reports how tall its content is (`onContentHeight`), so the
 * panel can fit it; if someone gave the panel a fixed height (`manual`) that's too short, it scrolls. While
 * `editing` it can't be clicked, only dragged, and a `manual` card has a "Fit to content" button (`onFit`).
 */
export function ProjectHealthCard({ project: p, checks, series, now, range, compact, fill = false, editing = false, manual = false, onFit, onContentHeight }: { project: Project; checks: HealthCheck[]; series: AllSeries | null; now: number; range: (typeof RANGES)[number]; compact: boolean; fill?: boolean; editing?: boolean; manual?: boolean; onFit?: () => void; onContentHeight?: (px: number) => void }) {
  const [ref, { width, height }] = useSize<HTMLDivElement>()
  const dense = compact || width < AUTO_COMPACT_BELOW
  useEffect(() => {
    if (onContentHeight && Number.isFinite(height)) onContentHeight(Math.ceil(height) + CARD_CHROME)
  }, [height, onContentHeight])
  const sorted = [...checks].sort(
    (a, b) => Number(!a.enabled) - Number(!b.enabled) || SEVERITY[a.status] - SEVERITY[b.status] || a.name.localeCompare(b.name),
  )
  const shown = dense ? sorted.slice(0, COMPACT_MAX_ROWS) : sorted
  const hidden = sorted.length - shown.length
  const all = checks.filter((c) => c.enabled).flatMap((c) => series?.series[c.id] ?? [])
  const uptime = series ? uptimeOf(all) : null
  // Strip length follows the room it has, so bars stay about the same size in narrow and wide cards.
  const slots = Number.isFinite(width) ? Math.max(12, Math.min(60, Math.round((width - 250) / 7))) : 48
  const narrow = width < AUTO_COMPACT_BELOW
  const narrowSlots = Number.isFinite(width) ? Math.max(12, Math.min(40, Math.round(width / 7))) : 24
  return (
    <div className={cx('relative', fill && 'h-full')}>
    <Card className={cx('group/card relative p-4 transition hover:border-zinc-600 has-[[data-project-link]:focus-visible]:border-emerald-500', fill && 'h-full overflow-y-auto')}>
      <div ref={ref}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link to={`/projects/${p.key}`} data-project-link title={`Open ${p.name}`} className="group flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 after:absolute after:inset-0 after:content-['']">
              <StatusDot status={p.health_status} />
              <span className="max-w-full truncate text-base font-semibold text-zinc-50 group-hover:underline">{p.name}</span>
              {p.failing_jobs > 0 && <Badge tone="red">{p.failing_jobs} job{p.failing_jobs === 1 ? '' : 's'} failing</Badge>}
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-400 transition group-hover/card:text-zinc-100">
                <NavIcon name="chevron" size={16} />
              </span>
            </Link>
            {p.website_url && <WebsiteLink url={p.website_url} title={`Open ${hostOf(p.website_url)}`} className="relative z-10 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800" />}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-lg font-semibold tabular-nums text-zinc-50">{fmtPct(uptime)}</div>
            <div className="text-xs text-zinc-400">uptime, {range.label}</div>
          </div>
        </div>
        <div className="-mx-2 space-y-1">
          {shown.map((c) =>
            dense ? (
              <CompactRow key={c.id} c={c} series={series} now={now} slots={narrow ? narrowSlots : slots} showUptime={width >= HIDE_ROW_UPTIME_BELOW} narrow={narrow} />
            ) : (
              <ComfortableRow key={c.id} c={c} series={series} now={now} slots={slots} />
            ),
          )}
          {hidden > 0 && <div className="px-2 pt-1 text-xs text-zinc-400">+{hidden} more {hidden === 1 ? 'check' : 'checks'} · open the project to see all</div>}
        </div>
        <div className="mt-3 flex justify-between text-xs text-zinc-400">
          <span>{range.ago}</span>
          <span>now</span>
        </div>
      </div>
    </Card>
    {editing && <div className="card-drag-handle absolute inset-0 z-30 cursor-move rounded-lg border-2 border-dashed border-emerald-500/60 bg-zinc-950/20" aria-hidden="true" />}
    {editing && manual && (
      <button type="button" onClick={onFit} className="absolute top-2 right-2 z-40 rounded border border-zinc-600 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800">
        Fit to content
      </button>
    )}
    </div>
  )
}

const ROW = 'group relative z-10 block rounded-md px-2 transition hover:bg-zinc-800/60'

/** A check with its response-time line and history strip. */
function ComfortableRow({ c, series, now, slots }: { c: HealthCheck; series: AllSeries | null; now: number; slots: number }) {
  const b = series?.series[c.id] ?? []
  const old = isStale(c, now)
  return (
    <Link to={`/checks/${c.id}`} aria-label={`Open check ${c.name}`} className={cx(ROW, 'py-2')}>
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
          <span className="text-zinc-600 transition group-hover:text-zinc-100"><NavIcon name="chevron" size={14} /></span>
        </span>
      </div>
      {series ? (
        // One chart: response-time line with its status strip directly underneath as the x-axis.
        <div className={cx(!c.enabled && 'opacity-60')}>
          <Sparkline buckets={b} windowSeconds={series.window_seconds} bucketSeconds={series.bucket_seconds} height={36} />
          <div className="mt-1">
            <UptimeBar buckets={b} windowSeconds={series.window_seconds} slots={slots} height="h-2" paused={!c.enabled} since={c.created_at} />
          </div>
        </div>
      ) : (
        <div className="h-11 animate-pulse rounded bg-zinc-800/60" />
      )}
    </Link>
  )
}

/** A check on one line: name, history strip, uptime, latency (or its problem state). */
function CompactRow({ c, series, now, slots, showUptime, narrow }: { c: HealthCheck; series: AllSeries | null; now: number; slots: number; showUptime: boolean; narrow: boolean }) {
  const b = series?.series[c.id] ?? []
  const old = isStale(c, now)
  const problem = c.status !== 'up' || !c.enabled
  const status = problem ? <HealthBadge status={c.status} paused={!c.enabled} /> : old ? <Badge tone="amber">stale</Badge> : <span title="Last response time">{c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}</span>
  if (narrow) {
    return (
      <Link to={`/checks/${c.id}`} aria-label={`Open check ${c.name}`} title={`${c.name} · last checked ${c.last_checked_at ? fmtTime(c.last_checked_at) : 'not yet'}`} className={cx(ROW, 'py-1.5 text-sm')}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot status={c.enabled ? c.status : 'disabled'} />
            <span className="truncate text-zinc-100 group-hover:underline">{c.name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-400">{status}</span>
        </div>
        <div className={cx('mt-1', !c.enabled && 'opacity-60')}>
          {series ? <UptimeBar buckets={b} windowSeconds={series.window_seconds} slots={slots} height="h-2.5" paused={!c.enabled} since={c.created_at} /> : <div className="h-2.5 animate-pulse rounded bg-zinc-800/60" />}
        </div>
      </Link>
    )
  }
  return (
    <Link
      to={`/checks/${c.id}`}
      aria-label={`Open check ${c.name}`}
      title={`${c.name} · last checked ${c.last_checked_at ? fmtTime(c.last_checked_at) : 'not yet'}`}
      className={cx(ROW, 'flex items-center gap-2.5 py-1.5 text-sm')}
    >
      <StatusDot status={c.enabled ? c.status : 'disabled'} />
      <span className="w-28 shrink-0 truncate text-zinc-100 group-hover:underline">{c.name}</span>
      <div className={cx('min-w-0 flex-1', !c.enabled && 'opacity-60')}>
        {series ? <UptimeBar buckets={b} windowSeconds={series.window_seconds} slots={slots} height="h-3" paused={!c.enabled} since={c.created_at} /> : <div className="h-3 animate-pulse rounded bg-zinc-800/60" />}
      </div>
      {showUptime && <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-400" title="Uptime in the selected range">{c.enabled ? fmtPct(series ? uptimeOf(b) : null) : '—'}</span>}
      <span className="flex w-16 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-zinc-400">{status}</span>
      <span className="shrink-0 text-zinc-600 transition group-hover:text-zinc-100"><NavIcon name="chevron" size={14} /></span>
    </Link>
  )
}
