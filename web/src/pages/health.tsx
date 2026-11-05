import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, canWrite, type HealthCheck, type HealthEvent, type HealthStatus, type Project, type SeriesBucket, type Service, type ServiceFilter, type Uptime } from '../api'
import { useAuth } from '../auth'
import { ActionMenu, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatusDot, cx, fmtTime, timeAgo } from '../ui'
import { fmtDuration, responseStats, UptimeBar } from './charts'
import { EnvBadge, EnvironmentSelect, ServiceBadge, ServiceSelect, serviceQuery, useEnvironments, useServices } from './services'

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

export function ProjectChecks({ project, services, scope }: { project: Project; services: Service[]; scope: ServiceFilter }) {
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ checks: HealthCheck[] }>(`/api/projects/${encodeURIComponent(project.key)}/checks${serviceQuery(scope, '?')}`)
      .then((r) => setChecks(r.checks))
      .catch((e) => setError(e.message))
  }, [project.key, scope])
  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <section id="checks" className="mt-6 scroll-mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-zinc-200">Health checks</h2>
        {writable && (
          <Link to={`/projects/${project.key}/checks/new${scope && scope !== '-' ? `?service=${scope}` : ''}`}>
            <Button variant="secondary">Add check</Button>
          </Link>
        )}
      </div>
      <ErrorBox error={error} />
      {!checks ? (
        <Spinner />
      ) : checks.length === 0 ? (
        <Empty title={scope ? 'No health checks here' : 'No health checks yet'}>Add a check to watch a URL: status code, response time and SSL expiry.</Empty>
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
                      {services.length > 0 && !scope && <ServiceBadge r={c} />}
                      <EnvBadge env={c.environment} />
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

/** Rounds up to a tidy axis maximum: 1, 2, 2.5 or 5 × a power of ten. */
function niceCeil(v: number): number {
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= v) return f * mag
  return 10 * mag
}

/** Width of an element, kept up to date (charts draw at real pixel size, so text never stretches). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function ResponseChart({ series, limit, height = 200 }: { series: Series; limit: number | null; height?: number }) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const H = height
  const pad = { l: 52, r: 8, t: 8, b: 22 }
  const innerW = Math.max(1, W - pad.l - pad.r)
  const innerH = H - pad.t - pad.b
  const end = Date.now()
  const start = end - series.window_seconds * 1000
  const x = (t: number) => pad.l + ((t - start) / (series.window_seconds * 1000)) * innerW
  const bucketW = Math.max(2, (series.bucket_seconds / series.window_seconds) * innerW)
  const mid = (b: SeriesBucket) => new Date(b.t).getTime() + (series.bucket_seconds * 1000) / 2

  const pts = series.buckets.filter((b) => b.avg_ms != null)
  // Scale to the data. The slow-response limit is drawn only when it sits near the data,
  // so a far-away limit can't squash the line flat against the bottom.
  const dataMax = Math.max(...pts.map((b) => b.avg_ms as number), 50)
  let top = niceCeil(dataMax * 1.15)
  const showLimit = limit != null && limit <= top * 1.5
  if (showLimit && limit != null && limit > top) top = niceCeil(limit * 1.1)
  const y = (ms: number) => pad.t + (1 - ms / top) * innerH
  const ticks = [0, top / 2, top]

  const line = pts.map((b, i) => `${i ? 'L' : 'M'}${x(mid(b)).toFixed(1)},${y(b.avg_ms as number).toFixed(1)}`).join(' ')
  const area = pts.length
    ? `${line} L${x(mid(pts[pts.length - 1])).toFixed(1)},${pad.t + innerH} L${x(mid(pts[0])).toFixed(1)},${pad.t + innerH} Z`
    : ''
  const fmtX = (t: number) =>
    series.window_seconds <= 6 * 3600
      ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : series.window_seconds <= 86_400
        ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!pts.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = start + ((e.clientX - r.left - pad.l) / innerW) * (end - start)
    let best = 0
    pts.forEach((b, i) => {
      if (Math.abs(mid(b) - t) < Math.abs(mid(pts[best]) - t)) best = i
    })
    setHover(best)
  }
  const h = hover != null ? pts[hover] : null

  return (
    <div ref={ref} className="relative" style={{ height: H }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {series.buckets.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-zinc-500">No results in this range yet</div>
      ) : W > 0 && (
        <svg width={W} height={H} role="img" aria-label="Response time chart" className="block">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--color-zinc-800)' }} />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" style={{ fill: 'var(--color-zinc-500)' }}>{Math.round(v)} ms</text>
            </g>
          ))}
          {series.buckets.map((b) =>
            b.fail > 0 ? <rect key={`f${b.t}`} x={x(new Date(b.t).getTime())} y={pad.t} width={bucketW} height={innerH} style={{ fill: 'var(--st-down)' }} opacity="0.22" /> : null,
          )}
          {showLimit && limit != null && (
            <g>
              <line x1={pad.l} x2={W - pad.r} y1={y(limit)} y2={y(limit)} style={{ stroke: 'var(--st-degraded)' }} strokeDasharray="4 4" opacity="0.8" />
              <text x={W - pad.r} y={y(limit) - 4} textAnchor="end" fontSize="11" style={{ fill: 'var(--st-degraded)' }}>slow above {limit} ms</text>
            </g>
          )}
          {area && <path d={area} style={{ fill: 'var(--chart-line)' }} opacity="0.12" />}
          {line && <path d={line} fill="none" style={{ stroke: 'var(--chart-line)' }} strokeWidth="2" strokeLinejoin="round" />}
          {h && (
            <g>
              <line x1={x(mid(h))} x2={x(mid(h))} y1={pad.t} y2={pad.t + innerH} style={{ stroke: 'var(--color-zinc-500)' }} />
              <circle cx={x(mid(h))} cy={y(h.avg_ms as number)} r="4" style={{ fill: 'var(--chart-line)', stroke: 'var(--color-zinc-900)' }} strokeWidth="2" />
            </g>
          )}
          {[start, start + (end - start) / 2, end].map((t, i) => (
            <text key={i} x={i === 0 ? pad.l : x(t)} y={H - 4} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize="11" style={{ fill: 'var(--color-zinc-500)' }}>{fmtX(t)}</text>
          ))}
        </svg>
      )}
      {h && (
        <div
          className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg"
          style={{ left: x(mid(h)), transform: `translateX(${x(mid(h)) > W * 0.6 ? 'calc(-100% - 10px)' : '10px'})` }}
        >
          <div className="text-zinc-400">{fmtTime(h.t)}</div>
          <div><b className="font-semibold">{Math.round(h.avg_ms as number)} ms</b> avg{h.max_ms != null && ` · ${h.max_ms} ms max`}</div>
          <div className="text-zinc-400">{h.ok + h.fail} check{h.ok + h.fail === 1 ? '' : 's'}{h.fail > 0 && <span className="text-red-300"> · {h.fail} failed</span>}</div>
        </div>
      )}
      {!showLimit && limit != null && pts.length > 0 && (
        <div className="absolute right-2 top-0 text-[11px] text-zinc-500">slow above {limit} ms · off this scale</div>
      )}
    </div>
  )
}

// ───────────────────────── check detail ─────────────────────────

const VALUE_TONE = { up: 'text-emerald-400', degraded: 'text-amber-300', down: 'text-red-400', unknown: 'text-zinc-300' } as const

function pctTone(v: number | null): string {
  if (v == null) return 'text-zinc-50'
  return v >= 99.5 ? 'text-emerald-400' : v >= 95 ? 'text-amber-300' : 'text-red-400'
}

/** One cell of the stat strip. */
function Cell({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx('mt-0.5 truncate text-lg font-semibold', className ?? 'text-zinc-50')}>{value}</div>
      {sub && <div className="truncate text-xs text-zinc-500">{sub}</div>}
    </div>
  )
}

function StatStrip({ check: c, uptime }: { check: HealthCheck; uptime: Uptime }) {
  const days = sslDays(c.ssl_expires_at)
  const since = c.status_since ? Date.now() - new Date(c.status_since).getTime() : null
  const sslWarn = days != null && (days < 0 || (c.ssl_warn_days != null && days < c.ssl_warn_days))
  return (
    <Card className="mb-4 grid grid-cols-2 divide-zinc-800 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x [&>*]:border-zinc-800 max-lg:[&>*]:border-b">
      <Cell
        label="Status"
        value={c.enabled ? STATUS_LABEL[c.status] : 'Paused'}
        className={c.enabled ? VALUE_TONE[c.status] : 'text-zinc-400'}
        sub={!c.enabled ? 'not being checked' : since != null && c.status !== 'unknown' ? `for ${fmtDuration(since)}` : 'waiting for results'}
      />
      <Cell
        label="Last check"
        value={<span title={fmtTime(c.last_checked_at)}>{c.last_checked_at ? timeAgo(c.last_checked_at) : 'never'}</span>}
        sub={`every ${fmtInterval(c.interval_seconds)}${c.last_status_code ? ` · HTTP ${c.last_status_code}` : ''}`}
      />
      <Cell label="Response" value={c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'} sub="latest" />
      <Cell label="Uptime 24h" value={fmtPct(uptime['24h'])} className={pctTone(uptime['24h'])} sub={`7d ${fmtPct(uptime['7d'])}`} />
      <Cell label="Uptime 30d" value={fmtPct(uptime['30d'])} className={pctTone(uptime['30d'])} sub="last 30 days" />
      <Cell
        label="SSL certificate"
        value={days == null ? (c.url.startsWith('https') ? 'not seen yet' : 'n/a') : days < 0 ? 'expired' : `${days} days`}
        className={sslWarn ? 'text-amber-300' : undefined}
        sub={c.ssl_expires_at ? `until ${new Date(c.ssl_expires_at).toLocaleDateString()}` : c.url.startsWith('https') ? undefined : 'plain http'}
      />
    </Card>
  )
}

function Availability({ check: c, day, events }: { check: HealthCheck; day: Series; events: HealthEvent[] }) {
  const cutoff = Date.now() - 86_400_000
  const incidents = events.filter((e) => e.to_status === 'down' && new Date(e.at).getTime() > cutoff).length
  // Estimated: the share of failed probes in each bucket times the bucket length.
  const downMs = day.buckets.reduce((sum, b) => sum + (b.ok + b.fail ? (b.fail / (b.ok + b.fail)) * day.bucket_seconds * 1000 : 0), 0)
  return (
    <Card className="mb-4 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-zinc-200">Last 24 hours</span>
        <span className="text-xs text-zinc-500">
          {incidents} incident{incidents === 1 ? '' : 's'} · {downMs >= 60_000 ? `about ${fmtDuration(downMs)} down` : 'no downtime'}
        </span>
      </div>
      <UptimeBar buckets={day.buckets} windowSeconds={day.window_seconds} slots={60} height="h-6" paused={!c.enabled} />
      <div className="mt-1.5 flex justify-between text-[11px] text-zinc-500">
        <span>24h ago</span>
        <span className="hidden sm:inline">
          <i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--st-up)' }} />up
          <i className="ml-3 mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--st-degraded)' }} />some failed
          <i className="ml-3 mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--st-down)' }} />down
          <i className="ml-3 mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--st-none)' }} />no data
        </span>
        <span>now</span>
      </div>
    </Card>
  )
}

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
  const [day, setDay] = useState<Series | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const [d, s, s24] = await Promise.all([
        api<Detail>(`/api/checks/${id}`),
        api<Series>(`/api/checks/${id}/series?range=${range}`),
        range === '24h' ? Promise.resolve(null) : api<Series>(`/api/checks/${id}/series?range=24h`),
      ])
      setDetail(d)
      setSeries(s)
      setDay(s24 ?? s)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id, range])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <ErrorBox error={error} persistent />
  if (!detail || !series || !day) return <Spinner />
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


  const st = responseStats(series.buckets)

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Projects', to: '/projects' },
          { label: c.project_name, to: `/projects/${c.project_key}` },
          { label: 'Health checks', to: `/projects/${c.project_key}#checks` },
          { label: c.name },
        ]}
        title={
          <span className="flex items-center gap-2.5">
            <StatusDot status={c.enabled ? c.status : 'disabled'} />
            {c.name}
            <HealthBadge status={c.status} paused={!c.enabled} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {c.service_name && <span className="text-zinc-400">{c.service_name}</span>}
            {c.environment && <EnvBadge env={c.environment} />}
            <a href={c.url} target="_blank" rel="noreferrer" className="mono truncate text-zinc-400 hover:text-zinc-200 hover:underline">{c.method} {c.url}</a>
          </span>
        }
        actions={
          writable && (
            <>
              <Button onClick={runNow} disabled={running} className="px-3 py-1.5">{running ? 'Checking…' : 'Check now'}</Button>
              <Button variant="secondary" onClick={toggle} className="px-3 py-1.5">{c.enabled ? 'Pause' : 'Resume'}</Button>
              <Link to={`/checks/${c.id}/edit`}><Button variant="secondary" className="px-3 py-1.5">Edit</Button></Link>
              <ActionMenu items={[{ label: 'Delete check', onClick: remove, danger: true }]} />
            </>
          )
        }
      />

      {c.enabled && c.status === 'down' && c.last_error && (
        <div className="mb-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
          <b>Down</b>{c.status_since ? ` since ${fmtTime(c.status_since)}` : ''} — {c.last_error}
        </div>
      )}
      {c.enabled && c.status === 'degraded' && (
        <div className="mb-4 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-2.5 text-sm text-amber-300">
          <b>Degraded</b> — {degradedReason(c)}
        </div>
      )}

      <StatStrip check={c} uptime={uptime} />
      <Availability check={c} day={day} events={events} />

      <Card className="mb-6 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-sm font-medium text-zinc-200">Response time</h2>
            {st.avg != null && (
              <span className="text-xs text-zinc-500">
                avg <b className="font-semibold text-zinc-200">{st.avg} ms</b>
                <span className="mx-2 text-zinc-700">|</span>min <b className="font-semibold text-zinc-200">{st.min} ms</b>
                <span className="mx-2 text-zinc-700">|</span>max <b className="font-semibold text-zinc-200">{st.max} ms</b>
              </span>
            )}
          </div>
          <div className="inline-flex rounded-md border border-zinc-800 p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                aria-pressed={r === range}
                className={cx('rounded px-2.5 py-1 text-xs', r === range ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <ResponseChart series={series} limit={c.max_response_ms} />
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-200">Recent status changes</h2>
          {events.length === 0 ? (
            <Card className="px-4 py-3 text-sm text-zinc-500">No status changes yet.</Card>
          ) : (
            <Card className="divide-y divide-zinc-800/70">
              {events.map((e) => (
                <div key={e.id} className="px-4 py-2 text-sm">
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
          <h2 className="mb-2 text-sm font-medium text-zinc-200">Settings</h2>
          <Card className="divide-y divide-zinc-800/70 text-sm">
            <Row label="Checked every" value={fmtInterval(c.interval_seconds)} />
            <Row label="Timeout" value={`${c.timeout_seconds}s`} />
            <Row label="Expected status" value={<span className="mono">{c.expected_status}</span>} />
            <Row label="Slow above" value={c.max_response_ms != null ? `${c.max_response_ms} ms` : 'not flagged'} />
            <Row label="SSL warning" value={c.ssl_warn_days != null ? `${c.ssl_warn_days} days before expiry` : 'off'} />
            <Row label="Down after" value={`${c.down_threshold} failed check${c.down_threshold === 1 ? '' : 's'} in a row`} />
            <Row label="Up again after" value={`${c.recovery_threshold} successful check${c.recovery_threshold === 1 ? '' : 's'} in a row`} />
            <Row label="Next check" value={c.enabled ? timeAgo(c.next_check_at) : '—'} />
          </Card>
        </section>
      </div>
    </>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2">
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
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const editing = !!id

  const [loaded, setLoaded] = useState(!editing)
  const [projectKey, setProjectKey] = useState(key ?? '')
  const [serviceId, setServiceId] = useState(params.get('service') ?? '')
  const [environmentId, setEnvironmentId] = useState('')
  const { services } = useServices(projectKey)
  const envs = useEnvironments(projectKey)
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
        setServiceId(c.service_id ?? '')
        setEnvironmentId(c.environment_id ?? '')
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
      service_id: serviceId,
      environment_id: environmentId,
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
        crumbs={[
          { label: 'Projects', to: '/projects' },
          { label: projectKey, to: `/projects/${projectKey}` },
          { label: 'Health checks', to: `/projects/${projectKey}#checks` },
          { label: editing ? 'Edit' : 'New check' },
        ]}
        title={editing ? 'Edit health check' : 'New health check'}
        subtitle={<>Project: <Link to={`/projects/${projectKey}`} className="text-zinc-300 hover:underline">{projectKey}</Link></>}
      />
      <Card className="max-w-2xl p-5">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Website" required autoFocus />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Service" hint={services && services.length === 0 ? 'This project has no services — the check belongs to the project.' : undefined}>
              <ServiceSelect services={services ?? []} value={serviceId} onChange={setServiceId} disabled={!services?.length} />
            </Field>
            {envs.length > 0 && (
              <Field label="Environment" hint="Optional — e.g. a staging URL">
                <EnvironmentSelect envs={envs} value={environmentId} onChange={setEnvironmentId} />
              </Field>
            )}
          </div>

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
