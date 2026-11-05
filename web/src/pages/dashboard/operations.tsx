import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { type AlertChannel, type AlertRecord, type BackupStatus, type Job, type Secret } from '../../api'
import { Card, StatusDot, cx, timeAgo } from '../../ui'
import { backupLabel } from '../backups'
import { ExpiryBadge } from '../vault'
import { type Section, type AlertsStatus, scopeName } from './shared'

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', email: 'Email' }

/** The most recent delivery attempt (alert or test) to each channel, by channel name. */
function lastDelivery(history: AlertRecord[], channelName: string): AlertRecord | undefined {
  return history.find((h) => h.channel_name === channelName) // history is newest first
}

/** Why nobody would be notified (no channels, or all switched off), or null when at least one is on. */
export function alertsProblem(a: AlertsStatus): string | null {
  if (a.channels.length === 0) return 'No alert channels set up'
  if (!a.channels.some((c) => c.enabled)) return 'All alert channels are off'
  return null
}

/** Enabled channels whose latest delivery failed. */
export function failingChannels(a: AlertsStatus): AlertChannel[] {
  return a.channels.filter((c) => c.enabled && lastDelivery(a.history, c.name)?.status === 'failed')
}

type OpsTone = 'ok' | 'warn' | 'bad' | 'run' | 'none'
const OPS_DOT = { ok: 'up', warn: 'degraded', bad: 'down', run: 'running', none: 'none' } as const
const OPS_TEXT: Record<OpsTone, string> = { ok: 'text-zinc-400', warn: 'text-amber-300', bad: 'text-red-300', run: 'text-sky-300', none: 'text-zinc-400' }

interface OpsDetail {
  id: string
  to: string
  title: string
  sub?: string
  right?: ReactNode
}
interface OpsRow {
  id: string
  label: string
  hint?: string
  to: string
  tone: OpsTone
  summary: string
  details?: OpsDetail[]
}

/**
 * Jobs, keys, alert channels and backups in one card. Every row is a single line while healthy and only
 * grows a short list underneath when something needs a look.
 */
export function OperationsPanel({ jobs, keys, alerts, backup }: {
  jobs?: { data: Job[] | null; error: boolean }
  keys?: { data: Secret[] | null; error: boolean }
  alerts?: Section<AlertsStatus>
  backup?: Section<BackupStatus>
}) {
  const rows: OpsRow[] = []
  const pending = (error: boolean) => (error ? 'Unavailable' : 'Loading…')

  if (jobs) {
    if (!jobs.data) {
      rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: pending(jobs.error) })
    } else {
      const active = jobs.data.filter((j) => j.enabled)
      const failing = active.filter((j) => j.last_status === 'failed')
      const times = active.flatMap((j) => (j.next_run_at ? [new Date(j.next_run_at).getTime()] : []))
      const next = times.length ? new Date(Math.min(...times)).toISOString() : null
      if (failing.length > 0) {
        rows.push({
          id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'bad', summary: `${failing.length} failing`,
          details: failing.map((j) => ({ id: j.id, to: `/jobs/${j.id}`, title: j.name, sub: scopeName(j), right: <span className="shrink-0 text-zinc-400">{j.last_run_at ? timeAgo(j.last_run_at) : ''}</span> })),
        })
      } else if (jobs.data.length === 0) {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: 'No jobs yet' })
      } else if (active.length === 0) {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'none', summary: 'All paused' })
      } else {
        rows.push({ id: 'jobs', label: 'Jobs', to: '/jobs', tone: 'ok', summary: `${active.length} active${next ? ` · next run ${timeAgo(next)}` : ''}` })
      }
    }
  }

  if (keys) {
    if (!keys.data) {
      rows.push({ id: 'keys', label: 'Keys', to: '/vault', tone: 'none', summary: pending(keys.error) })
    } else if (keys.data.length === 0) {
      rows.push({ id: 'keys', label: 'Keys', to: '/vault', tone: 'ok', summary: 'None expiring in 30 days' })
    } else {
      const soonest = [...keys.data].sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999))
      rows.push({
        id: 'keys', label: 'Keys', to: '/vault', tone: (soonest[0].days_left ?? 9999) <= 7 ? 'bad' : 'warn',
        summary: `${soonest.length} expiring within 30 days`,
        details: soonest.map((k) => ({ id: k.id, to: `/projects/${k.project_key}`, title: k.name, sub: k.environment, right: <ExpiryBadge secret={k} /> })),
      })
    }
  }

  if (alerts) {
    const a = alerts.data
    if (!a) {
      rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'none', summary: pending(!!alerts.error) })
    } else {
      const active = a.channels.filter((c) => c.enabled)
      const failing = failingChannels(a)
      if (a.channels.length === 0) {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'warn', summary: 'None set up — nobody gets notified' })
      } else if (active.length === 0) {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'warn', summary: 'All off — nobody gets notified' })
      } else if (failing.length > 0) {
        rows.push({
          id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'bad', summary: `${failing.length} failing`,
          details: failing.map((c) => {
            const d = lastDelivery(a.history, c.name)
            return { id: c.id, to: '/alerts', title: c.name, sub: CHANNEL_LABEL[c.type] ?? c.type, right: <span className="shrink-0 text-zinc-400">{d ? `failed ${timeAgo(d.at)}` : ''}</span> }
          }),
        })
      } else {
        rows.push({ id: 'alerts', label: 'Alerts', to: '/alerts', tone: 'ok', summary: `${active.length} ${active.length === 1 ? 'channel' : 'channels'} active` })
      }
    }
  }

  if (backup) {
    const s = backup.data
    if (!s) {
      rows.push({ id: 'backups', label: 'Backups', hint: 'Whole instance, not filtered by project', to: '/backups', tone: 'none', summary: pending(!!backup.error) })
    } else {
      const l = backupLabel(s)
      const tone: OpsTone = l.tone === 'green' ? 'ok' : l.tone === 'amber' ? 'warn' : l.tone === 'red' ? 'bad' : 'run'
      rows.push({
        id: 'backups', label: 'Backups', hint: 'Whole instance, not filtered by project', to: '/backups', tone, summary: l.text,
        details: s.state === 'failed' && s.last_error ? [{ id: 'err', to: '/backups', title: s.last_error }] : undefined,
      })
    }
  }

  if (rows.length === 0) return null
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">Operations</div>
      <ul className="divide-y divide-zinc-800/70">
        {rows.map((r) => (
          <li key={r.id}>
            <Link to={r.to} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-zinc-800/30">
              <StatusDot status={OPS_DOT[r.tone]} />
              <span className="shrink-0 font-medium text-zinc-100" title={r.hint}>{r.label}</span>
              <span className={cx('min-w-0 flex-1 truncate text-right text-xs', OPS_TEXT[r.tone])} title={r.summary}>{r.summary}</span>
            </Link>
            {r.details && (
              <ul className="pb-2">
                {r.details.slice(0, 3).map((d) => (
                  <li key={d.id}>
                    <Link to={d.to} className="flex items-center justify-between gap-2 py-1 pr-4 pl-10 text-xs hover:bg-zinc-800/30">
                      <span className="min-w-0 truncate text-zinc-300" title={d.title}>
                        {d.title}
                        {d.sub && <span className="ml-1.5 text-zinc-400">{d.sub}</span>}
                      </span>
                      {d.right}
                    </Link>
                  </li>
                ))}
                {r.details.length > 3 && <li className="py-1 pr-4 pl-10 text-xs text-zinc-400">+{r.details.length - 3} more</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
