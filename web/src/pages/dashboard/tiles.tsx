import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card, cx } from '../../ui'
import { Skel } from './skeleton'

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

/** Placeholder with the same height as a loaded tile. `extra` adds the room HealthTile's bar and chips take. */
function TileSkeleton({ label, extra }: { label: string; extra?: boolean }) {
  return (
    <Card className="h-full px-4 py-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 flex h-8 items-center"><Skel className="h-6 w-24" /></div>
      <div className="mt-0.5 flex min-h-4 items-center"><Skel className="h-3 w-32" /></div>
      {extra && (
        <>
          <Skel className="mt-2 h-1.5 w-full rounded-full" />
          <div className="mt-2 min-h-5" />
        </>
      )}
    </Card>
  )
}

export function Stat({ label, value, tone, sub, subTone, unavailable, loading, to }: { label: string; value: number | string; tone?: 'red' | 'amber' | 'green'; sub?: string; subTone?: 'amber'; unavailable?: boolean; loading?: boolean; to?: string }) {
  if (loading) return <TileSkeleton label={label} />
  const color = unavailable ? 'text-zinc-400' : tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'green' ? 'text-emerald-400' : 'text-zinc-100'
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
export function HealthTile({ loading, unavailable, total, healthy, down, degraded, unknown, stale, paused, to }: {
  loading?: boolean; unavailable: boolean; total: number; healthy: number; down: number; degraded: number; unknown: number; stale: number; paused: number; to: string
}) {
  if (loading) return <TileSkeleton label="Checks healthy" extra />
  const other = Math.max(0, total - healthy - down - degraded)
  const allGood = total > 0 && healthy === total
  const tone = unavailable ? 'text-zinc-400' : down ? 'text-red-400' : degraded ? 'text-amber-300' : allGood ? 'text-emerald-400' : 'text-zinc-100'
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
        <span className="text-xs text-zinc-400">{unavailable ? 'Unavailable' : total === 0 ? 'No active checks' : ''}</span>
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
        {!unavailable && chips.length === 0 && total > 0 && <span className="text-xs text-zinc-400">All reporting</span>}
        {chips.map((c) => (
          <span key={c.label} className={cx('inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', c.cls)}>{c.n} {c.label}</span>
        ))}
      </div>
    </Card>
  )
  return unavailable ? body : <TileLink to={to} className="block rounded-lg">{body}</TileLink>
}
