import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

import { Link } from 'react-router-dom'
import { formatDateTime } from './prefs'

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:py-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={cx('w-full rounded-lg border border-zinc-800 bg-zinc-950 p-5 shadow-xl', wide ? 'max-w-2xl' : 'max-w-xl')}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-50">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A "⋯" button that opens a small menu of actions. */
export function ActionMenu({ items, label = 'More actions' }: { items: { label: string; onClick: () => void; danger?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) return e.key === 'Escape' && setOpen(false)
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1.5 w-44 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
              className={cx('block w-full px-3.5 py-2 text-left text-sm hover:bg-zinc-800', it.danger ? 'text-red-400' : 'text-zinc-200')}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-emerald-500 text-[#052e16] hover:bg-emerald-400',
    secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700',
    danger: 'bg-red-600/90 text-white hover:bg-red-500',
    ghost: 'text-zinc-300 hover:bg-zinc-800',
  }
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
      {...props}
    />
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60'

export function Input({ className, type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false)
  if (type !== 'password') return <input className={cx(inputCls, className)} type={type} {...props} />
  // Password fields get a show/hide button.
  return (
    <div className="relative">
      <input className={cx(inputCls, 'pr-10', className)} type={shown ? 'text' : 'password'} {...props} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown(!shown)}
        aria-label={shown ? 'Hide' : 'Show'}
        title={shown ? 'Hide' : 'Show'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-400 hover:text-zinc-100"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </div>
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputCls, className)} {...props} />
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(inputCls, className)} {...props} />
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-zinc-800 bg-zinc-900/60', className)}>{children}</div>
}

/**
 * An error message with a ✕ to dismiss it. It comes back if a different error arrives (or the same one
 * after the error was cleared). `persistent` has no ✕ — for a page that failed to load, where there is
 * nothing else to show.
 */
export function ErrorBox({ error, persistent }: { error: string | null; persistent?: boolean }) {
  const [hidden, setHidden] = useState<string | null>(null)
  useEffect(() => {
    if (!error) setHidden(null)
  }, [error])
  if (!error || hidden === error) return null
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
      <span className="min-w-0 break-words">{error}</span>
      {!persistent && (
        <button type="button" onClick={() => setHidden(error)} aria-label="Dismiss" title="Dismiss" className="shrink-0 text-red-400 hover:text-red-100">✕</button>
      )}
    </div>
  )
}

/** Accessible tab bar (arrow keys move between tabs). The caller renders the active panel. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(next.id)
    document.getElementById(`tab-${next.id}`)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className="mb-6 flex gap-1 overflow-x-auto border-b border-zinc-800">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-medium',
            value === t.id ? 'border-emerald-500 text-zinc-50' : 'border-transparent text-zinc-400 hover:text-zinc-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export interface Crumb {
  label: string
  to?: string
}

/** "Projects › vidyakalp › Health checks › Render" — every part but the last is a link back. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 min-w-0">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-500">
        {items.map((c, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <span aria-hidden="true" className="text-zinc-600">›</span>}
            {c.to && i < items.length - 1 ? (
              <Link to={c.to} className="truncate hover:text-zinc-200 hover:underline">{c.label}</Link>
            ) : (
              <span aria-current={i === items.length - 1 ? 'page' : undefined} className="truncate text-zinc-300">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: Crumb[] }) {
  return (
    <div className="mb-6">
      {crumbs && <Breadcrumbs items={crumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-zinc-50">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export type DotStatus = 'success' | 'failed' | 'running' | 'disabled' | 'none' | 'up' | 'degraded' | 'down' | 'unknown'

export function StatusDot({ status }: { status: DotStatus | null }) {
  const map: Record<DotStatus, string> = {
    success: 'bg-emerald-400',
    up: 'bg-emerald-400',
    failed: 'bg-red-500',
    down: 'bg-red-500',
    degraded: 'bg-amber-400',
    running: 'bg-sky-400 animate-pulse',
    disabled: 'bg-zinc-600',
    unknown: 'bg-zinc-600',
    none: 'bg-zinc-600',
  }
  return <span className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', map[status ?? 'none'])} />
}

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'zinc' | 'green' | 'red' | 'amber' | 'sky' }) {
  const tones = {
    zinc: 'bg-zinc-800 text-zinc-300',
    green: 'bg-emerald-950 text-emerald-300 border border-emerald-900',
    red: 'bg-red-950 text-red-300 border border-red-900',
    amber: 'bg-amber-950 text-amber-300 border border-amber-900',
    sky: 'bg-sky-950 text-sky-300 border border-sky-900',
  }
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center">
      <div className="font-medium text-zinc-300">{title}</div>
      {children && <div className="mt-2 text-sm text-zinc-500">{children}</div>}
    </div>
  )
}

export function Spinner() {
  return <div className="p-8 text-sm text-zinc-500">Loading…</div>
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ]
  for (const [ms, u] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms)
      return future ? `in ${n}${u}` : `${n}${u} ago`
    }
  }
  return future ? 'in a moment' : 'just now'
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return formatDateTime(iso)
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold text-zinc-50">Rexus</span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-zinc-400">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}
