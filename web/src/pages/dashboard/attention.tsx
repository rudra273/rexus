import { Link } from 'react-router-dom'
import { Badge, Card, StatusDot } from '../../ui'
import { type AttentionItem } from './shared'
import { Skel } from './skeleton'

export function AttentionPanel({ items, loading, failed, noChecks }: { items: AttentionItem[]; loading: boolean; failed: boolean; noChecks: boolean }) {
  if (loading) {
    return (
      <div id="needs-attention" className="scroll-mt-4">
        <Card className="px-4 py-3"><Skel className="h-5 w-44" /></Card>
      </div>
    )
  }
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
                    <span className="shrink-0 whitespace-nowrap"><Badge tone={i.tone}>{i.label}</Badge></span>
                    <span className="truncate text-zinc-100">{i.title}</span>
                  </span>
                  {i.right && <span className="shrink-0 whitespace-nowrap">{i.right}</span>}
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
