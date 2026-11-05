import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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
      <div className="w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-950 p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-50">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        {children}
      </div>
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
    primary: 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400',
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

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputCls, className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputCls, className)} {...props} />
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(inputCls, className)} {...props} />
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
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

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-zinc-50">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
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
  return new Date(iso).toLocaleString()
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
