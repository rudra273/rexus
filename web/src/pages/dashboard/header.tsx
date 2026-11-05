import { useEffect, useState } from 'react'
import { cx, timeAgo } from '../../ui'
import { REFRESH_MS, RANGES, type RangeId } from './shared'

/** "Updated 12s ago · auto-refresh every 30s" with a live dot: pulses while loading, amber when something failed. */
export function LiveStatus({ updated, refreshing, stale }: { updated: number | null; refreshing: boolean; stale: boolean }) {
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
export function RangeSwitch({ value, onChange }: { value: RangeId; onChange: (r: RangeId) => void }) {
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
