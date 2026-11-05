import { useRef, useState, type MouseEvent } from 'react'
import type { SeriesBucket } from '../api'
import { cx, fmtTime } from '../ui'

/** One time slot of an uptime bar. */
interface Slot {
  start: number
  end: number
  ok: number
  fail: number
}

/** Splits the last `windowSeconds` into `n` equal slots and adds each bucket to the slot it falls in. */
export function toSlots(buckets: SeriesBucket[], windowSeconds: number, n: number, now = Date.now()): Slot[] {
  const size = (windowSeconds * 1000) / n
  const start = now - windowSeconds * 1000
  const slots: Slot[] = Array.from({ length: n }, (_, i) => ({ start: start + i * size, end: start + (i + 1) * size, ok: 0, fail: 0 }))
  for (const b of buckets) {
    const i = Math.floor((new Date(b.t).getTime() - start) / size)
    const s = slots[Math.min(Math.max(i, 0), n - 1)]
    s.ok += b.ok
    s.fail += b.fail
  }
  return slots
}

/** Share of successful probes, or null when there were none. */
export function uptimeOf(buckets: SeriesBucket[]): number | null {
  let ok = 0
  let all = 0
  for (const b of buckets) {
    ok += b.ok
    all += b.ok + b.fail
  }
  return all ? (ok / all) * 100 : null
}

export function responseStats(buckets: SeriesBucket[]) {
  let sum = 0
  let n = 0
  let min: number | null = null
  let max: number | null = null
  for (const b of buckets) {
    if (b.avg_ms == null) continue
    const count = b.ok + b.fail || 1
    sum += b.avg_ms * count
    n += count
    const lo = b.min_ms ?? b.avg_ms
    const hi = b.max_ms ?? b.avg_ms
    min = min == null ? lo : Math.min(min, lo)
    max = max == null ? hi : Math.max(max, hi)
  }
  return { avg: n ? Math.round(sum / n) : null, min: min == null ? null : Math.round(min), max: max == null ? null : Math.round(max) }
}

function slotState(s: Slot): { color: string; label: string } {
  const all = s.ok + s.fail
  if (all === 0) return { color: 'var(--st-none)', label: 'no data' }
  if (s.fail === 0) return { color: 'var(--st-up)', label: '100% up' }
  if (s.ok === 0) return { color: 'var(--st-down)', label: 'down' }
  return { color: 'var(--st-degraded)', label: `${((s.ok / all) * 100).toFixed(1)}% up` }
}

/**
 * A row of small bars, one per time slot: green = every probe passed, amber = some failed,
 * red = all failed, grey = no data. Each bar has a tooltip, so colour is never the only cue.
 */
export function UptimeBar({ buckets, windowSeconds, slots = 24, height = 'h-6', paused }: { buckets: SeriesBucket[]; windowSeconds: number; slots?: number; height?: string; paused?: boolean }) {
  const data = toSlots(buckets, windowSeconds, slots)
  return (
    <div className={cx('flex gap-[2px]', paused && 'opacity-50')} role="img" aria-label={`Uptime over the last ${Math.round(windowSeconds / 3600)} hours`}>
      {data.map((s) => {
        const st = slotState(s)
        return (
          <div
            key={s.start}
            className={cx('min-w-0 flex-1 rounded-[3px]', height)}
            style={{ background: st.color }}
            title={`${fmtTime(new Date(s.start).toISOString())} – ${st.label}${s.ok + s.fail ? ` (${s.ok + s.fail} checks)` : ''}`}
          />
        )
      })}
    </div>
  )
}

/**
 * Response-time line for a small space (dashboard cards). Hovering shows a crosshair and the value
 * of the nearest point; failed probes are marked with red ticks along the bottom.
 */
export function Sparkline({ buckets, windowSeconds, bucketSeconds, height = 44 }: { buckets: SeriesBucket[]; windowSeconds: number; bucketSeconds: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null) // index into points
  const W = 300
  const H = height
  const end = Date.now()
  const start = end - windowSeconds * 1000
  const pts = buckets
    .filter((b) => b.avg_ms != null)
    .map((b) => ({ b, t: new Date(b.t).getTime() + (bucketSeconds * 1000) / 2, v: b.avg_ms as number }))
  if (pts.length === 0) {
    return <div className="flex items-center text-xs text-zinc-500" style={{ height }}>No response data yet</div>
  }
  const top = Math.max(...pts.map((p) => p.v), 50) * 1.15
  const x = (t: number) => ((t - start) / (end - start)) * W
  const y = (v: number) => H - 2 - (v / top) * (H - 6)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(pts[pts.length - 1].t).toFixed(1)},${H} L${x(pts[0].t).toFixed(1)},${H} Z`
  const fails = buckets.filter((b) => b.fail > 0)

  const onMove = (e: MouseEvent) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const t = start + ((e.clientX - r.left) / r.width) * (end - start)
    let best = 0
    pts.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(pts[best].t - t)) best = i
    })
    setHover(best)
  }
  const h = hover != null ? pts[hover] : null

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-full w-full" aria-hidden="true">
        <path d={area} style={{ fill: 'var(--chart-line)', opacity: 0.12 }} />
        <path d={line} fill="none" style={{ stroke: 'var(--chart-line)' }} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {fails.map((b) => (
          <rect key={b.t} x={x(new Date(b.t).getTime())} y={H - 3} width={Math.max(2, (bucketSeconds / windowSeconds) * W)} height={3} style={{ fill: 'var(--st-down)' }} />
        ))}
        {h && <line x1={x(h.t)} x2={x(h.t)} y1={0} y2={H} style={{ stroke: 'var(--color-zinc-500)' }} strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute -top-1 z-10 whitespace-nowrap rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 shadow"
          style={{ left: `${(x(h.t) / W) * 100}%`, transform: `translate(${x(h.t) / W > 0.6 ? '-100%' : '0'}, -100%)` }}
        >
          <b className="font-medium">{Math.round(h.v)} ms</b> avg · {fmtTime(h.b.t)}
          {h.b.fail > 0 && <span className="text-red-300"> · {h.b.fail} failed</span>}
        </div>
      )}
    </div>
  )
}

/** "2d 4h", "35m", "12s" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
