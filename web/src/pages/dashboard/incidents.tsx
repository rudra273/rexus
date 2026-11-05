import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, StatusDot, timeAgo } from '../../ui'
import { fmtDuration } from '../charts'
import { RANGES, type RecentEvent } from './shared'
import { Skel } from './skeleton'

export interface Incident {
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
export function toIncidents(events: RecentEvent[]): Incident[] {
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

export function IncidentsPanel({ incidents, error, range }: { incidents: Incident[] | null; error: boolean; range: (typeof RANGES)[number] }) {
  const [all, setAll] = useState(false)
  let body: ReactNode
  if (!incidents) {
    body = error ? <Card className="px-4 py-3 text-sm text-zinc-400">Incident history is unavailable right now.</Card> : <Card className="px-4 py-3"><Skel className="h-5 w-48" /></Card>
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
                    {i.end === null ? <Badge tone="red">Ongoing</Badge> : dur && <span className="shrink-0 text-xs tabular-nums text-zinc-400">{dur}</span>}
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
