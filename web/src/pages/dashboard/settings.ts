import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { Placement, SavedLayout } from './layout'
import type { CardDensity } from './shared'

/** How the dashboard's project cards look. One copy for the whole Rexus: everyone sees it, owner and admins change it. */
export interface DashboardSettings {
  density: CardDensity
  layout: SavedLayout
}

const DEFAULTS: DashboardSettings = { density: 'comfortable', layout: {} }
const SAVE_DELAY_MS = 600
const POLL_MS = 60_000

/** Makes whatever the server sent safe to use. */
function normalize(raw: Partial<DashboardSettings> | null): DashboardSettings {
  const layout: SavedLayout = {}
  for (const [id, p] of Object.entries(raw?.layout ?? {})) {
    const v = p as Partial<Placement>
    if ([v.x, v.y, v.w, v.h].every((n) => Number.isFinite(n))) layout[id] = { x: v.x!, y: v.y!, w: v.w!, h: v.h!, auto: v.auto !== false }
  }
  return { density: raw?.density === 'compact' ? 'compact' : 'comfortable', layout }
}

function same(a: DashboardSettings, b: DashboardSettings): boolean {
  if (a.density !== b.density) return false
  const ka = Object.keys(a.layout)
  if (ka.length !== Object.keys(b.layout).length) return false
  return ka.every((id) => {
    const p = a.layout[id]
    const q = b.layout[id]
    return !!q && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h && p.auto === q.auto
  })
}

// Before these lived on the server they were kept per browser. The first admin to open the dashboard
// carries what's in their browser over, once, if the server has nothing yet.
const LEGACY_LAYOUT = 'rexus.dashboard.layout'
const LEGACY_DENSITY = 'rexus.dashboard.density'

function readLegacy(): DashboardSettings | null {
  try {
    const rawLayout = localStorage.getItem(LEGACY_LAYOUT)
    const rawDensity = localStorage.getItem(LEGACY_DENSITY)
    if (!rawLayout && !rawDensity) return null
    const layout: SavedLayout = {}
    for (const [id, p] of Object.entries(JSON.parse(rawLayout ?? '{}') as Record<string, Partial<Placement>>)) {
      // Old heights were fixed; cards now fit their content, so only the positions and widths carry over.
      if ([p.x, p.y, p.w, p.h].every((n) => Number.isFinite(n))) layout[id] = { x: p.x!, y: p.y!, w: p.w!, h: p.h!, auto: true }
    }
    return { density: rawDensity === 'compact' ? 'compact' : 'comfortable', layout }
  } catch {
    return null
  }
}

function clearLegacy() {
  try {
    localStorage.removeItem(LEGACY_LAYOUT)
    localStorage.removeItem(LEGACY_DENSITY)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Loads the shared dashboard settings and, for owner/admin (`canEdit`), saves changes a moment after the last
 * one. It checks the server again every minute so a change made by someone else shows up, but never while
 * this person is editing or has an unsaved change. `syncCount` goes up when settings arrive from elsewhere.
 */
export function useDashboardSettings(canEdit: boolean, editing: boolean) {
  const [settings, setSettings] = useState<DashboardSettings | null>(null)
  const [syncCount, setSyncCount] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const current = useRef<DashboardSettings | null>(null)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const editingRef = useRef(editing)
  const legacyPending = useRef(false)

  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  const flush = useCallback(async () => {
    timer.current = undefined
    const body = current.current
    if (!body) return
    dirty.current = false
    try {
      await api('/api/dashboard/settings', { method: 'PUT', body })
      setSaveError(null)
      if (legacyPending.current) {
        legacyPending.current = false
        clearLegacy()
      }
    } catch (e) {
      dirty.current = true // keep what's on screen; the next change tries again
      setSaveError((e as Error).message)
    }
  }, [])

  const schedule = useCallback(() => {
    dirty.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS)
  }, [flush])

  const load = useCallback(async () => {
    try {
      let next = normalize(await api<Partial<DashboardSettings>>('/api/dashboard/settings'))
      const prev = current.current
      if (!prev) {
        const unset = Object.keys(next.layout).length === 0 && next.density === 'comfortable'
        const legacy = canEdit && unset ? readLegacy() : null
        if (legacy) {
          next = legacy
          legacyPending.current = true
        }
        current.current = next
        setSettings(next)
        if (legacy) schedule()
        return
      }
      if (dirty.current || editingRef.current || same(prev, next)) return
      current.current = next
      setSettings(next)
      setSyncCount((n) => n + 1)
    } catch {
      if (!current.current) {
        current.current = DEFAULTS
        setSettings(DEFAULTS)
      }
    }
  }, [canEdit, schedule])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // Leaving the page with a change still waiting to be saved: send it now.
  useEffect(
    () => () => {
      if (dirty.current) {
        window.clearTimeout(timer.current)
        void flush()
      }
    },
    [flush],
  )

  const update = useCallback(
    (patch: Partial<DashboardSettings>) => {
      if (!canEdit) return
      const next = { ...(current.current ?? DEFAULTS), ...patch }
      current.current = next
      setSettings(next)
      schedule()
    },
    [canEdit, schedule],
  )

  return { settings, syncCount, saveError, update }
}
