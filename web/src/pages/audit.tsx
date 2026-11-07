import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AuditRow } from '../api'
import { NavIcon } from '../icons'
import { Badge, Button, Card, Empty, ErrorBox, Input, Modal, PageHeader, Select, Spinner, fmtTime, timeAgo } from '../ui'

const CATEGORIES = {
  alert: 'Alerts',
  auth: 'Authentication',
  backup: 'Backups',
  check: 'Health checks',
  dashboard: 'Dashboard',
  env: 'Deploy access',
  environment: 'Environments',
  job: 'Jobs',
  owner: 'Ownership',
  project: 'Projects',
  secret: 'Vault secrets',
  service: 'Services',
  settings: 'Settings',
  token: 'API tokens',
  user: 'Users',
}

function actionTone(action: string) {
  if (/failed|delete|disable|revoke/.test(action)) return 'red'
  return action.startsWith('secret.') ? 'sky' : 'zinc'
}

function targetLabel(entry: AuditRow) {
  const label = entry.details?.name ?? entry.details?.email ?? entry.details?.project
  if (typeof label === 'string' && label) return label
  return entry.target_type?.replaceAll('_', ' ') ?? '—'
}

export function AuditPage() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [days, setDays] = useState('')
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [selected, setSelected] = useState<AuditRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestID = useRef(0)

  const load = useCallback(async (before?: number) => {
    const id = ++requestID.current
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '50' })
    if (query.trim()) params.set('q', query.trim())
    if (category) params.set('category', category)
    if (days) params.set('days', days)
    if (before) params.set('before', String(before))
    try {
      const result = await api<{ entries: AuditRow[]; has_more: boolean }>(`/api/audit?${params}`)
      if (requestID.current !== id) return
      setRows((current) => before && current ? [...current, ...result.entries] : result.entries)
      setMore(result.has_more)
    } catch (err) {
      if (requestID.current === id) setError((err as Error).message)
    } finally {
      if (requestID.current === id) setLoading(false)
    }
  }, [query, category, days])

  useEffect(() => {
    setRows(null)
    setMore(false)
    setLoading(true)
    const timer = setTimeout(() => void load(), 200)
    return () => {
      clearTimeout(timer)
      requestID.current++
    }
  }, [load])

  const filtered = Boolean(query.trim() || category || days)
  const reset = () => {
    setQuery('')
    setCategory('')
    setDays('')
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Review account activity and changes across the workspace."
        actions={<Button variant="secondary" disabled={loading} onClick={() => void load()}><NavIcon name="refresh" size={16} /> Refresh</Button>}
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 p-3 sm:p-4">
          <div className="relative min-w-0 flex-[1_1_14rem] sm:max-w-sm">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-500"><NavIcon name="search" size={16} /></span>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search by actor or action" placeholder="Search by actor or action…" className="pl-8" />
          </div>
          <Select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto! max-w-full">
            <option value="">All categories</option>
            {Object.entries(CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select>
          <Select aria-label="Filter by date range" value={days} onChange={(e) => setDays(e.target.value)} className="w-auto! max-w-full">
            <option value="">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
          {filtered && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
        </div>

        {error && <div className="px-4 pt-3"><ErrorBox error={error} persistent /></div>}
        {!rows ? (
          loading ? <div className="p-5"><Spinner /></div> : null
        ) : rows.length === 0 ? (
          <div className="p-4"><Empty title={filtered ? 'No matching entries' : 'No activity recorded'}>
            {filtered ? 'Try a different search, category, or date range.' : 'Workspace activity will appear here.'}
          </Empty></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
                  <tr>{['Action', 'Actor', 'Target', 'When', 'Details'].map((heading) => <th key={heading} scope="col" className="px-4 py-2.5 font-medium">{heading}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {rows.map((entry) => (
                    <tr key={entry.id} className="hover:bg-zinc-800/25">
                      <td className="px-4 py-3"><Badge tone={actionTone(entry.action)}>{entry.action}</Badge></td>
                      <td className="max-w-56 break-words px-4 py-3 text-zinc-300">{entry.actor || 'System'}</td>
                      <td className="max-w-56 break-words px-4 py-3 text-zinc-400">{targetLabel(entry)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400"><time dateTime={entry.at} title={fmtTime(entry.at)}>{timeAgo(entry.at)}</time></td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" className="inline-flex items-center gap-1 text-xs text-zinc-300 hover:text-emerald-300" onClick={() => setSelected(entry)} aria-label={`View audit entry ${entry.id}`}>View <NavIcon name="chevron" size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
              <span className="text-xs text-zinc-400" role="status">{rows.length} {rows.length === 1 ? 'entry' : 'entries'} shown · newest first</span>
              {more && <Button variant="secondary" disabled={loading} onClick={() => void load(rows[rows.length - 1].id)}>{loading ? 'Loading…' : 'Load older entries'}</Button>}
            </div>
          </>
        )}
      </Card>

      {selected && (
        <Modal wide title="Audit entry" onClose={() => setSelected(null)}>
          <div className="mb-4 flex items-center gap-2">
            <Badge tone={actionTone(selected.action)}>{selected.action}</Badge>
            <span className="text-xs text-zinc-500">#{selected.id}</span>
          </div>
          <dl className="grid gap-3 rounded-md border border-zinc-800 p-3 text-sm sm:grid-cols-2">
            {[
              ['Actor', selected.actor || 'System'],
              ['Time', fmtTime(selected.at)],
              ['Target type', selected.target_type?.replaceAll('_', ' ')],
              ['IP address', selected.ip],
              ['Target ID', selected.target_id],
            ].map(([label, value]) => (
              <div key={label}><dt className="text-xs text-zinc-400">{label}</dt><dd className="mt-1 break-all text-zinc-200">{value || '—'}</dd></div>
            ))}
          </dl>
          <h3 className="mb-2 mt-4 text-sm font-medium text-zinc-200">Event details</h3>
          {Object.keys(selected.details ?? {}).length > 0 ? (
            <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">{JSON.stringify(selected.details, null, 2)}</pre>
          ) : <p className="text-sm text-zinc-400">No additional details recorded.</p>}
        </Modal>
      )}
    </>
  )
}
