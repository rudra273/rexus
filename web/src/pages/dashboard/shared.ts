import { useCallback, useState, type ReactNode } from 'react'
import type { AlertChannel, AlertRecord, HealthCheck, HealthStatus, SeriesBucket } from '../../api'

/** One independently loaded part of the dashboard. A failed refresh keeps the last good data. */
export interface Section<T> {
  data: T | null
  error: string | null
  at: number | null // when data was last fetched successfully
}

export function useSection<T>(): [Section<T>, (p: Promise<T>) => Promise<void>] {
  const [s, setS] = useState<Section<T>>({ data: null, error: null, at: null })
  const run = useCallback(
    (p: Promise<T>) =>
      p.then(
        (data) => setS({ data, error: null, at: Date.now() }),
        (e: Error) => setS((prev) => ({ ...prev, error: e.message })),
      ),
    [],
  )
  return [s, run]
}

export interface AllSeries {
  window_seconds: number
  bucket_seconds: number
  series: Record<string, SeriesBucket[]>
}

export const REFRESH_MS = 30_000
export const RANGES = [
  { id: '24h', label: '24h', words: '24 hours', ago: '24 hours ago' },
  { id: '7d', label: '7d', words: '7 days', ago: '7 days ago' },
  { id: '30d', label: '30d', words: '30 days', ago: '30 days ago' },
] as const
export type RangeId = (typeof RANGES)[number]['id']

/** Alert channels plus recent deliveries, admin only. */
export interface AlertsStatus {
  channels: AlertChannel[]
  history: AlertRecord[]
}

/** A status change as returned by /api/checks/events. */
export interface RecentEvent {
  id: number
  at: string
  from_status: HealthStatus
  to_status: HealthStatus
  message: string
  check_id: string
  check_name: string
  project_key: string
  project_name: string
}
const FILTER_KEY = 'rexus.dashboard.project'

export function readStoredFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function storeFilter(key: string) {
  try {
    localStorage.setItem(FILTER_KEY, key)
  } catch {
    /* private mode: the URL still carries it */
  }
}

/** A check that should have reported by now but hasn't (3 intervals, at least 5 minutes). */
export function isStale(c: HealthCheck, now: number): boolean {
  if (!c.enabled || !c.last_checked_at) return false
  return now - new Date(c.last_checked_at).getTime() > Math.max(c.interval_seconds * 3, 300) * 1000
}

export function scopeName(r: { project_name: string; service_key: string | null }) {
  return r.service_key ? `${r.project_name} / ${r.service_key}` : r.project_name
}

export const SEVERITY = { down: 0, degraded: 1, unknown: 2, up: 3, none: 4 } as const

export interface AttentionItem {
  id: string
  tone: 'red' | 'amber'
  label: string
  title: string
  sub: string
  to: string
  right?: ReactNode
}
