import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type HealthCheck, type Job } from '../../api'
import { Card, timeAgo } from '../../ui'
import { WORLD_LAND } from './world_land'

type Location = { country: string; city: string; latitude: number; longitude: number; ip: string }
type Locations = { locations: Record<string, Location | null>; pending: boolean }
type Destination = { id: string; name: string; host: string; kind: string; status: string; at: string | null; to: string; project: string }
function hostname(raw: string) {
  try { return new URL(raw).hostname } catch { return '' }
}
const color = (status: string) => status === 'down' || status === 'failed' ? 'var(--st-down)' : status === 'degraded' ? 'var(--st-degraded)' : status === 'up' || status === 'success' ? 'var(--st-up)' : 'var(--color-zinc-500)'

export function RegionsPanel({ checks, jobs }: { checks: HealthCheck[] | null; jobs: Job[] | null }) {
  const [data, setData] = useState<Locations | null>(null)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      let delay = 60_000
      try {
        const next = await api<Locations>('/api/dashboard/locations')
        if (cancelled) return
        setData(next)
        setError(false)
        if (next.pending) delay = 3000
      } catch { if (!cancelled) setError(true) }
      if (!cancelled) timer = setTimeout(refresh, delay)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])
  const destinations: Destination[] = [
    ...(checks ?? []).map(c => ({ id: `check-${c.id}`, name: c.name, host: hostname(c.url), kind: 'Check', status: c.enabled ? c.status : 'paused', at: c.last_checked_at, to: `/checks/${c.id}`, project: c.project_name })),
    ...(jobs ?? []).map(j => ({ id: `job-${j.id}`, name: j.name, host: hostname(j.config.url), kind: 'Job', status: j.enabled ? j.last_status ?? 'unknown' : 'paused', at: j.last_run_at, to: `/jobs/${j.id}`, project: j.project_name })),
  ]
  const groups = new Map<string, { location: Location; items: Destination[] }>()
  const unavailable: Destination[] = []
  for (const item of destinations) {
    const location = data?.locations[item.host]
    if (!location) { unavailable.push(item); continue }
    // Nearby endpoints share one marker so every item remains reachable in a small map.
    const key = `${Math.round(location.longitude / 8)},${Math.round(location.latitude / 8)}`
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { location, items: [item] })
  }
  const active = selected === 'unknown' ? unavailable : groups.get(selected ?? '')?.items
  const title = selected === 'unknown' ? 'Location unavailable' : groups.get(selected ?? '')?.location.country
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-sm font-medium text-zinc-200">Regions<span className="text-emerald-400">.</span></h2>
        <span className="text-[11px] text-zinc-400">{destinations.length} destinations</span>
      </div>
      <div className="relative mx-4 mt-3 aspect-[360/165]">
        <svg viewBox="0 0 360 165" className="h-full w-full" aria-label="World map of approximate request destinations">
          <path d={WORLD_LAND} fill="var(--color-zinc-800)" stroke="var(--color-zinc-500)" strokeWidth="0.6" strokeLinejoin="round" />
        </svg>
        {[...groups].map(([key, group]) => {
          const status = group.items.find(i => i.status === 'down' || i.status === 'failed')?.status ?? group.items.find(i => i.status === 'degraded')?.status ?? group.items.find(i => i.status === 'up' || i.status === 'success')?.status ?? 'unknown'
          return <button key={key} type="button" className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2" style={{ left: `${(group.location.longitude + 180) / 360 * 100}%`, top: `${(85 - group.location.latitude) / 165 * 100}%`, background: `color-mix(in srgb, ${color(status)} 20%, transparent)` }} onMouseEnter={() => setSelected(key)} onFocus={() => setSelected(key)} onClick={() => setSelected(key)} onKeyDown={e => { if (e.key === 'Escape') setSelected(null) }} aria-label={`${group.location.country}, ${group.items.length} destinations, ${status}`}><span className="h-3 w-3 rounded-full" style={{ background: color(status) }} /></button>
        })}
        {active && selected !== 'unknown' && <div className="pointer-events-none absolute bottom-0 left-0 rounded bg-zinc-900/95 px-2 py-1 text-xs text-zinc-100 shadow">{title} · {active.length} destinations</div>}
      </div>
      <div className="px-4 pb-3 pt-2">
        <p className="text-xs text-zinc-400">{error ? 'Couldn’t refresh locations.' : !data || data.pending ? 'Locating destinations…' : destinations.length === 0 ? 'No checks or jobs in this project.' : 'Hover or select a region to explore.'}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...groups].map(([key, group]) => <button type="button" key={key} onMouseEnter={() => setSelected(key)} onFocus={() => setSelected(key)} onClick={() => setSelected(key)} className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">{group.location.city || group.location.country} · {group.items.length}</button>)}
          {unavailable.length > 0 && <button type="button" onClick={() => setSelected('unknown')} className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400">Location unavailable · {unavailable.length}</button>}
        </div>
        {active && <div className="mt-3 border-t border-zinc-800 pt-2">
          <div className="mb-1 text-xs font-medium text-zinc-200">{title}</div>
          <ul className="max-h-44 space-y-1 overflow-y-auto">{active.map(item => <li key={item.id}><Link to={item.to} className="block rounded px-1 py-1.5 text-xs hover:bg-zinc-800">
            <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color(item.status) }} /><span className="truncate text-zinc-100">{item.name}</span><span className="ml-auto shrink-0 text-zinc-400">{item.status}</span></div>
            <div className="mt-0.5 truncate text-zinc-400">{item.kind} · {item.project} · {item.host}</div>
            <div className="mt-0.5 text-zinc-500">{data?.locations[item.host]?.city} {data?.locations[item.host]?.country} · {item.at ? timeAgo(item.at) : 'No runs yet'}</div>
          </Link></li>)}</ul>
        </div>}
        <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">Approximate destination IP locations. CDN locations can differ from origin servers. <a href="https://ipwhois.io" target="_blank" rel="noreferrer" className="hover:underline">IPWhois</a> · <a href="https://www.naturalearthdata.com" target="_blank" rel="noreferrer" className="hover:underline">Natural Earth</a></p>
      </div>
    </Card>
  )
}
