import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * Personal display preferences. They are stored in this browser (localStorage), not on the server:
 * they follow the browser, not the account, and never affect anyone else. Defaults keep the
 * original look: dark theme, comfortable density, the browser's timezone and date style.
 */
export type Theme = 'dark' | 'light' | 'system'
export type Density = 'comfortable' | 'compact'
export type DateFormat = 'system' | 'iso' | 'dmy' | 'mdy'

export interface Prefs {
  theme: Theme
  density: Density
  /** '' = the browser's timezone, otherwise an IANA name such as "Europe/London". */
  timezone: string
  dateFormat: DateFormat
}

export const DEFAULT_PREFS: Prefs = { theme: 'dark', density: 'comfortable', timezone: '', dateFormat: 'system' }

const STORAGE_KEY = 'rexus.prefs'

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function validTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz === '') return ''
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return tz
  } catch {
    return ''
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Prefs>
    return {
      theme: oneOf(raw.theme, ['dark', 'light', 'system'], DEFAULT_PREFS.theme),
      density: oneOf(raw.density, ['comfortable', 'compact'], DEFAULT_PREFS.density),
      timezone: validTimezone(raw.timezone),
      dateFormat: oneOf(raw.dateFormat, ['system', 'iso', 'dmy', 'mdy'], DEFAULT_PREFS.dateFormat),
    }
  } catch {
    // Storage blocked or unreadable: fall back to the defaults.
    return DEFAULT_PREFS
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Not persisted (private mode, storage full) — the choice still applies until reload.
  }
}

// The current choice, readable by plain functions such as fmtTime.
let current: Prefs = loadPrefs()

const LOCALES: Record<Exclude<DateFormat, 'system'>, string> = { iso: 'sv-SE', dmy: 'en-GB', mdy: 'en-US' }

/** Date and time in the user's chosen timezone and style. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const timeZone = current.timezone || undefined
  const locale = current.dateFormat === 'system' ? undefined : LOCALES[current.dateFormat]
  try {
    return d.toLocaleString(locale, { timeZone })
  } catch {
    return d.toLocaleString()
  }
}

function systemDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/** Writes the choices onto <html> so CSS can react to them. */
export function applyPrefs(p: Prefs) {
  const dark = p.theme === 'dark' || (p.theme === 'system' && systemDark())
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.density = p.density
}

// Apply before React renders, so there is no flash of the wrong theme.
applyPrefs(current)

interface PrefsState {
  prefs: Prefs
  set: (patch: Partial<Prefs>) => void
  reset: () => void
}

const PrefsContext = createContext<PrefsState | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(current)

  const update = useCallback((next: Prefs) => {
    current = next
    savePrefs(next)
    applyPrefs(next)
    setPrefs(next)
  }, [])

  const set = useCallback((patch: Partial<Prefs>) => update({ ...current, ...patch }), [update])
  const reset = useCallback(() => update(DEFAULT_PREFS), [update])

  // "System" follows the operating system when it switches between light and dark.
  useEffect(() => {
    if (prefs.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyPrefs(current)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [prefs.theme])

  const value = useMemo(() => ({ prefs, set, reset }), [prefs, set, reset])
  // Changing timezone or date style re-renders the whole tree, so every formatted time updates.
  return (
    <PrefsContext.Provider value={value}>
      <div key={`${prefs.timezone}|${prefs.dateFormat}`} className="contents">
        {children}
      </div>
    </PrefsContext.Provider>
  )
}

export function usePrefs() {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs outside PrefsProvider')
  return ctx
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

export function timezoneList(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    const list = f ? f('timeZone') : []
    if (list.length) return list.includes('UTC') ? list : ['UTC', ...list]
  } catch {
    // fall through
  }
  return ['UTC']
}
