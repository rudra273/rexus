import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, canWrite, type HealthCheck, type HealthEvent, type HealthStatus, type Project, type SeriesBucket, type Uptime } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatusDot, cx, fmtTime, timeAgo } from '../ui'

// ───────────────────────── helpers ─────────────────────────

export function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 99.995) return '100%'
  return `${v.toFixed(v >= 99 ? 2 : 1)}%`
}

export function sslDays(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

export function fmtInterval(s: number): string {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`
  if (s % 60 === 0) return `${s / 60} min`
  return `${s}s`
}

const STATUS_LABEL: Record<HealthStatus, string> = { up: 'Up', degraded: 'Degraded', down: 'Down', unknown: 'Checking…' }
const STATUS_TONE = { up: 'green', degraded: 'amber', down: 'red', unknown: 'zinc' } as const

export function HealthBadge({ status, paused }: { status: HealthStatus; paused?: boolean }) {
  if (paused) return <Badge>paused</Badge>
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
}

/** Why a degraded check is degraded, derived from its latest data. */
export function degradedReason(c: HealthCheck): string {
  if (c.max_response_ms != null && c.last_response_ms != null && c.last_response_ms > c.max_response_ms) {
    return `slow: ${c.last_response_ms} ms (limit ${c.max_response_ms} ms)`
  }
  const d = sslDays(c.ssl_expires_at)
  if (c.ssl_warn_days != null && d != null && d < c.ssl_warn_days) return `SSL certificate expires in ${d} day${d === 1 ? '' : 's'}`
  return 'degraded'
}

function SslBadge({ check }: { check: HealthCheck }) {
  const d = sslDays(check.ssl_expires_at)
  if (d == null) return null
  const warn = check.ssl_warn_days ?? 14
  if (d < 0) return <Badge tone="red">SSL expired</Badge>
  if (d < Math.min(warn, 7)) return <Badge tone="red">SSL {d}d</Badge>
  if (d < warn) return <Badge tone="amber">SSL {d}d</Badge>
  return <span className="text-xs text-zinc-500">SSL {d}d</span>
}

// ───────────────────────── project page: list of checks ─────────────────────────

export function ProjectChecks({ project }: { project: Project }) {
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ checks: HealthCheck[] }>(`/api/projects/${encodeURIComponent(project.key)}/checks`)
      .then((r) => setChecks(r.checks))
      .catch((e) => setError(e.message))
  }, [project.key])
  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Health checks</h2>
        {writable && (
          <Link to={`/projects/${project.key}/checks/new`}>
            <Button variant="secondary">Add check</Button>
          </Link>
        )}
      </div>
      <ErrorBox error={error} />
      {!checks ? (
        <Spinner />
      ) : checks.length === 0 ? (
        <Empty title="No health checks yet">Add a check to watch a URL: status code, response time and SSL expiry.</Empty>
      ) : (
        <div className="space-y-2">
          {checks.map((c) => (
            <Link key={c.id} to={`/checks/${c.id}`} className="block">
              <Card className="px-4 py-3 transition hover:border-zinc-600">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={c.enabled ? c.status : 'disabled'} />
                      <span className="truncate font-medium text-zinc-100">{c.name}</span>
                      <HealthBadge status={c.status} paused={!c.enabled} />
                    </div>
                    <div className="mt-0.5 max-w-md truncate text-xs text-zinc-500 mono">{c.method} {c.url}</div>
                    {c.enabled && c.status === 'down' && c.last_error && <div className="mt-1 text-xs text-red-300">{c.last_error}</div>}
                    {c.enabled && c.status === 'degraded' && <div className="mt-1 text-xs text-amber-300">{degradedReason(c)}</div>}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-zinc-400">
                    <span title="Last response time">{c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}</span>
                    <span title="Uptime, last 24 hours">{fmtPct(c.uptime_24h)}</span>
                    <SslBadge check={c} />
                    <span className="text-zinc-500">{c.last_checked_at ? timeAgo(c.last_checked_at) : 'not checked yet'}</span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

// ───────────────────────── response-time chart ─────────────────────────

const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const
type Range = (typeof RANGES)[number]

interface Series {
  range: Range
  window_seconds: number
  bucket_seconds: number
  buckets: SeriesBucket[]
}

function ResponseChart({ series, limit }: { series: Series; limit: number | null }) {
  const W = 640
  const H = 190
  const pad = { l: 46, r: 8, t: 10, b: 22 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b
  const end = Date.now()
  const start = end - series.window_seconds * 1000
  const x = (t: number) => pad.l + ((t - start) / (series.window_seconds * 1000)) * innerW
  const bucketW = Math.max(2, (series.bucket_seconds / series.window_seconds) * innerW)

  const withData = series.buckets.filter((b) => b.avg_ms != null)
  if (series.buckets.length === 0) return <Empty title="No results in this range yet" />

  const peak = Math.max(limit ?? 0, ...withData.map((b) => b.max_ms ?? b.avg_ms ?? 0), 100)
  const top = peak * 1.1
  const y = (ms: number) => pad.t + (1 - ms / top) * innerH
  const mid = (b: SeriesBucket) => new Date(b.t).getTime() + (series.bucket_seconds * 1000) / 2

  const line = withData.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(mid(b)).toFixed(1)},${y(b.avg_ms as number).toFixed(1)}`).join(' ')
  const ticks = [0, 0.5, 1].map((f) => Math.round(top * f))
  // Short windows: just the time. A day: date + time (so "10:22 … 10:22" isn't ambiguous). Longer: date.
  const fmtX = (t: number) =>
    series.window_seconds <= 6 * 3600
      ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : series.window_seconds <= 86_400
        ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Response time chart">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#27272a" />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#71717a">{v} ms</text>
        </g>
      ))}
      {limit != null && (
        <g>
          <line x1={pad.l} x2={W - pad.r} y1={y(limit)} y2={y(limit)} stroke="#fbbf24" strokeDasharray="4 3" opacity="0.7" />
          <text x={W - pad.r} y={y(limit) - 3} textAnchor="end" fontSize="10" fill="#fbbf24">limit {limit} ms</text>
        </g>
      )}
      {series.buckets.map((b) =>
        b.fail > 0 ? (
          <rect key={`f${b.t}`} x={x(new Date(b.t).getTime())} y={pad.t} width={bucketW} height={innerH} fill="#ef4444" opacity="0.28" />
        ) : null,
      )}
      {line && <path d={line} fill="none" stroke="#34d399" strokeWidth="1.6" strokeLinejoin="round" />}
      {withData.length <= 60 && withData.map((b) => <circle key={`c${b.t}`} cx={x(mid(b))} cy={y(b.avg_ms as number)} r="2" fill="#34d399" />)}
      {/* invisible hover targets with native tooltips */}
      {series.buckets.map((b) => (
        <rect key={`h${b.t}`} x={x(new Date(b.t).getTime())} y={pad.t} width={bucketW} height={innerH} fill="transparent">
          <title>
            {new Date(b.t).toLocaleString()}
            {b.avg_ms != null ? ` · avg ${Math.round(b.avg_ms)} ms, max ${b.max_ms} ms` : ''}
            {` · ${b.ok + b.fail} check${b.ok + b.fail === 1 ? '' : 's'}`}
            {b.fail > 0 ? ` · ${b.fail} failed` : ''}
          </title>
        </rect>
      ))}
      {[start, start + (end - start) / 2, end].map((t, i) => (
        <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize="10" fill="#71717a">{fmtX(t)}</text>
      ))}
    </svg>
  )
}

// ───────────────────────── check detail ─────────────────────────

interface Detail {
  check: HealthCheck
  uptime: Uptime
  events: HealthEvent[]
}

export function CheckDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const writable = !!user && canWrite(user.role)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [range, setRange] = useState<Range>('24h')
  const [series, setSeries] = useState<Series | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api<Detail>(`/api/checks/${id}`), api<Series>(`/api/checks/${id}/series?range=${range}`)])
      setDetail(d)
      setSeries(s)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id, range])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <ErrorBox error={error} />
  if (!detail || !series) return <Spinner />
  const { check: c, uptime, events } = detail

  const runNow = async () => {
    setRunning(true)
    try {
      await api(`/api/checks/${c.id}/run`, { method: 'POST' })
      setTimeout(load, 1200)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTimeout(() => setRunning(false), 1200)
    }
  }

  const toggle = async () => {
    try {
      await api(`/api/checks/${c.id}`, { method: 'PUT', body: { ...checkBody(c), enabled: !c.enabled } })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete health check "${c.name}" and its history?`)) return
    try {
      await api(`/api/checks/${c.id}`, { method: 'DELETE' })
      navigate(`/projects/${c.project_key}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const days = sslDays(c.ssl_expires_at)

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <StatusDot status={c.enabled ? c.status : 'disabled'} />
            {c.name}
            <HealthBadge status={c.status} paused={!c.enabled} />
          </span>
        }
        subtitle={
          <>
            <Link to={`/projects/${c.project_key}`} className="text-zinc-300 hover:underline">{c.project_name}</Link>
            <span className="mx-2 text-zinc-600">·</span>
            <span className="mono">{c.method} {c.url}</span>
          </>
        }
        actions={
          writable && (
            <>
              <Button onClick={runNow} disabled={running}>{running ? 'Checking…' : 'Check now'}</Button>
              <Button variant="secondary" onClick={toggle}>{c.enabled ? 'Pause' : 'Resume'}</Button>
              <Link to={`/checks/${c.id}/edit`}><Button variant="secondary">Edit</Button></Link>
              <Button variant="danger" onClick={remove}>Delete</Button>
            </>
          )
        }
      />

      {c.enabled && c.status === 'down' && c.last_error && (
        <div className="mb-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <b>Down</b>{c.status_since ? ` since ${fmtTime(c.status_since)}` : ''} — {c.last_error}
        </div>
      )}
      {c.enabled && c.status === 'degraded' && (
        <div className="mb-4 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          <b>Degraded</b> — {degradedReason(c)}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Status" value={<HealthBadge status={c.status} paused={!c.enabled} />} sub={c.status_since ? `since ${timeAgo(c.status_since)}` : undefined} />
        <Stat label="Last response" value={c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'} sub={c.last_status_code ? `HTTP ${c.last_status_code}` : undefined} />
        <Stat label="Uptime (24h · 7d · 30d)" value={`${fmtPct(uptime['24h'])} · ${fmtPct(uptime['7d'])} · ${fmtPct(uptime['30d'])}`} small />
        <Stat
          label="SSL certificate"
          value={days == null ? (c.url.startsWith('https') ? 'not seen yet' : 'n/a (http)') : days < 0 ? 'expired' : `${days} days left`}
          sub={c.ssl_expires_at ? `expires ${new Date(c.ssl_expires_at).toLocaleDateString()}` : undefined}
          tone={days != null && c.ssl_warn_days != null && days < c.ssl_warn_days ? 'amber' : undefined}
        />
      </div>

      <Card className="mb-6 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-zinc-200">Response time</h2>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cx('rounded px-2.5 py-1 text-xs', r === range ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <ResponseChart series={series} limit={c.max_response_ms} />
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-500">
          <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-400" />average response time</span>
          <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-red-500/50" />failed checks</span>
          <span>last checked {c.last_checked_at ? timeAgo(c.last_checked_at) : 'never'} · next {c.enabled ? timeAgo(c.next_check_at) : '—'}</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 font-medium text-zinc-200">Recent status changes</h2>
          {events.length === 0 ? (
            <Empty title="No incidents">Status changes show up here.</Empty>
          ) : (
            <Card className="divide-y divide-zinc-800/70">
              {events.map((e) => (
                <div key={e.id} className="px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <HealthBadge status={e.from_status} />
                    <span className="text-zinc-600">→</span>
                    <HealthBadge status={e.to_status} />
                    <span className="ml-auto text-xs text-zinc-500" title={fmtTime(e.at)}>{timeAgo(e.at)}</span>
                  </div>
                  {e.message && <div className="mt-1 text-xs text-zinc-400">{e.message}</div>}
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-3 font-medium text-zinc-200">Settings</h2>
          <Card className="divide-y divide-zinc-800/70 text-sm">
            <Row label="Checked every" value={fmtInterval(c.interval_seconds)} />
            <Row label="Timeout" value={`${c.timeout_seconds}s`} />
            <Row label="Expected status" value={<span className="mono">{c.expected_status}</span>} />
            <Row label="Slow above" value={c.max_response_ms != null ? `${c.max_response_ms} ms` : 'not flagged'} />
            <Row label="SSL warning" value={c.ssl_warn_days != null ? `${c.ssl_warn_days} days before expiry` : 'off'} />
            <Row label="Down after" value={`${c.down_threshold} failed check${c.down_threshold === 1 ? '' : 's'} in a row`} />
            <Row label="Up again after" value={`${c.recovery_threshold} successful check${c.recovery_threshold === 1 ? '' : 's'} in a row`} />
          </Card>
        </section>
      </div>
    </>
  )
}

function Stat({ label, value, sub, small, tone }: { label: string; value: ReactNode; sub?: string; small?: boolean; tone?: 'amber' }) {
  return (
    <Card className="min-w-0 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx('mt-1 truncate font-semibold', small ? 'text-base' : 'text-lg', tone === 'amber' ? 'text-amber-300' : 'text-zinc-100')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-zinc-400">{label}</span>
      <span className="text-right text-zinc-200">{value}</span>
    </div>
  )
}

/** The editable settings of a check, shaped for PUT /api/checks/:id. */
function checkBody(c: HealthCheck) {
  return {
    name: c.name,
    url: c.url,
    method: c.method,
    interval_seconds: c.interval_seconds,
    timeout_seconds: c.timeout_seconds,
    expected_status: c.expected_status,
    max_response_ms: c.max_response_ms,
    ssl_warn_days: c.ssl_warn_days,
    down_threshold: c.down_threshold,
    recovery_threshold: c.recovery_threshold,
    enabled: c.enabled,
  }
}

// ───────────────────────── add / edit form ─────────────────────────

const INTERVALS: [number, string][] = [
  [60, '1 minute'],
  [120, '2 minutes'],
  [300, '5 minutes'],
  [600, '10 minutes'],
  [900, '15 minutes'],
  [1800, '30 minutes'],
  [3600, '1 hour'],
  [21600, '6 hours'],
  [86400, '24 hours'],
]

export function CheckFormPage() {
  const { id, key } = useParams()
  const navigate = useNavigate()
  const editing = !!id

  const [loaded, setLoaded] = useState(!editing)
  const [projectKey, setProjectKey] = useState(key ?? '')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [method, setMethod] = useState('GET')
  const [interval, setIntervalS] = useState(300)
  const [timeout, setTimeoutS] = useState(10)
  const [expected, setExpected] = useState('200-299')
  const [slowOn, setSlowOn] = useState(false)
  const [slowMs, setSlowMs] = useState(2000)
  const [sslOn, setSslOn] = useState(true)
  const [sslDaysN, setSslDaysN] = useState(14)
  const [down, setDown] = useState(3)
  const [recovery, setRecovery] = useState(1)
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    api<{ check: HealthCheck }>(`/api/checks/${id}`)
      .then(({ check: c }) => {
        setProjectKey(c.project_key)
        setName(c.name)
        setUrl(c.url)
        setMethod(c.method)
        setIntervalS(c.interval_seconds)
        setTimeoutS(c.timeout_seconds)
        setExpected(c.expected_status)
        setSlowOn(c.max_response_ms != null)
        if (c.max_response_ms != null) setSlowMs(c.max_response_ms)
        setSslOn(c.ssl_warn_days != null)
        if (c.ssl_warn_days != null) setSslDaysN(c.ssl_warn_days)
        setDown(c.down_threshold)
        setRecovery(c.recovery_threshold)
        setEnabled(c.enabled)
        setLoaded(true)
      })
      .catch((e) => setError(e.message))
  }, [id])

  const https = url.trim().toLowerCase().startsWith('https://')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const body = {
      name,
      url,
      method,
      interval_seconds: interval,
      timeout_seconds: timeout,
      expected_status: expected,
      max_response_ms: slowOn ? slowMs : null,
      ssl_warn_days: https && sslOn ? sslDaysN : null,
      down_threshold: down,
      recovery_threshold: recovery,
      enabled,
    }
    try {
      const r = editing
        ? await api<{ check: HealthCheck }>(`/api/checks/${id}`, { method: 'PUT', body })
        : await api<{ check: HealthCheck }>(`/api/projects/${encodeURIComponent(projectKey)}/checks`, { method: 'POST', body })
      navigate(`/checks/${r.check.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Spinner />

  const intervalOptions = INTERVALS.some(([v]) => v === interval) ? INTERVALS : [...INTERVALS, [interval, fmtInterval(interval)] as [number, string]]

  return (
    <>
      <PageHeader
        title={editing ? 'Edit health check' : 'New health check'}
        subtitle={<>Project: <Link to={`/projects/${projectKey}`} className="text-zinc-300 hover:underline">{projectKey}</Link></>}
      />
      <Card className="max-w-2xl p-5">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Website" required autoFocus />
          </Field>

          <Field label="URL to check">
            <div className="flex gap-2">
              <div className="w-24 shrink-0">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option>GET</option>
                  <option>HEAD</option>
                </Select>
              </div>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.com/health" className="mono" required />
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Check every">
              <Select value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
                {intervalOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Timeout (seconds)" hint="Counts as a failure when slower">
              <Input type="number" min={1} max={60} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} />
            </Field>
            <Field label="Expected status" hint="e.g. 200, 200-299, 200,301">
              <Input value={expected} onChange={(e) => setExpected(e.target.value)} className="mono" />
            </Field>
          </div>

          <div className="space-y-3 rounded-md border border-zinc-800 p-4">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={slowOn} onChange={(e) => setSlowOn(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
              Mark as degraded when the response is slow
            </label>
            {slowOn && (
              <div className="flex items-center gap-2 pl-6 text-sm text-zinc-400">
                slower than
                <div className="w-28"><Input type="number" min={1} value={slowMs} onChange={(e) => setSlowMs(Number(e.target.value))} /></div>
                ms
              </div>
            )}
            <label className={cx('flex items-center gap-2 text-sm', https ? 'text-zinc-300' : 'text-zinc-600')}>
              <input type="checkbox" checked={https && sslOn} disabled={!https} onChange={(e) => setSslOn(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
              Mark as degraded when the SSL certificate is about to expire {!https && '(https URLs only)'}
            </label>
            {https && sslOn && (
              <div className="flex items-center gap-2 pl-6 text-sm text-zinc-400">
                within
                <div className="w-24"><Input type="number" min={1} max={365} value={sslDaysN} onChange={(e) => setSslDaysN(Number(e.target.value))} /></div>
                days
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Mark as down after" hint="failed checks in a row — avoids false alarms from one blip">
              <Input type="number" min={1} max={20} value={down} onChange={(e) => setDown(Number(e.target.value))} />
            </Field>
            <Field label="Mark as up again after" hint="successful checks in a row">
              <Input type="number" min={1} max={20} value={recovery} onChange={(e) => setRecovery(Number(e.target.value))} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
            Enabled
          </label>

          <ErrorBox error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save check' : 'Create check'}</Button>
            <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  )
}
