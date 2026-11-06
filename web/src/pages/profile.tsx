import { useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, isAdmin, type User } from '../api'
import { useAuth } from '../auth'
import { browserTimezone, timezoneList, usePrefs, type DateFormat, type Density, type Theme } from '../prefs'
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Tabs, fmtTime } from '../ui'
import { TwoFactorEnroll } from './auth'

type Tab = 'account' | 'security' | 'preferences'
const TABS: { id: Tab; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security' },
  { id: 'preferences', label: 'Preferences' },
]

export function ProfilePage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : 'account'

  if (!user) return null

  return (
    <>
      <PageHeader
        title="Profile"
      />
      <Tabs tabs={TABS} value={tab} onChange={(id) => setParams(id === 'account' ? {} : { tab: id }, { replace: true })} label="Profile sections" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="max-w-2xl">
        {tab === 'account' && <AccountTab user={user} />}
        {tab === 'security' && <SecurityTab user={user} />}
        {tab === 'preferences' && <PreferencesTab />}
      </div>
    </>
  )
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="min-w-0 truncate text-right text-zinc-200">{value}</span>
    </div>
  )
}

function NameRow({ user }: { user: User }) {
  const { setSession } = useAuth()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(user.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ user: User }>('/api/auth/profile', { method: 'PATCH', body: { name } })
      setSession({ user: r.user, next: 'ok' })
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
        <span className="text-zinc-400">Name</span>
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-zinc-200">{user.name || '—'}</span>
          <button type="button" onClick={() => { setName(user.name); setEditing(true) }} className="shrink-0 text-emerald-400 hover:text-emerald-300">
            Edit
          </button>
        </span>
      </div>
    )
  }
  return (
    <form onSubmit={save} className="space-y-2 px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <label htmlFor="p-name" className="w-16 shrink-0 text-zinc-400">Name</label>
        <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus required />
        <Button type="submit" disabled={busy || !name.trim() || name.trim() === user.name}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
      <ErrorBox error={error} />
    </form>
  )
}

function AccountTab({ user }: { user: User }) {
  return (
    <Card className="divide-y divide-zinc-800">
      <NameRow user={user} />
      <Row label="Email" value={user.email} />
      <Row label="Role" value={<Badge tone="green">{user.role}</Badge>} />
      <Row label="Last sign-in" value={fmtTime(user.last_login_at)} />
      <Row label="Member since" value={fmtTime(user.created_at)} />
    </Card>
  )
}

function SecurityTab({ user }: { user: User }) {
  const { meta, setSession } = useAuth()
  const [enrolling, setEnrolling] = useState(false)
  const [disableCode, setDisableCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Required-2FA policy is decided by the server; this only explains it.
  const twoFARequired = meta?.two_fa_mode === 'required' || (meta?.two_fa_mode === 'admins' && isAdmin(user.role))

  const disable2FA = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const r = await api<{ user: User }>('/api/auth/2fa/disable', { method: 'POST', body: { code: disableCode } })
      setSession({ user: r.user, next: 'ok' })
      setDisableCode('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 font-medium text-zinc-200">Two-factor authentication</h2>
        <Card className="px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">Authenticator app</span>
            {user.totp_enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">off</Badge>}
          </div>
          <ErrorBox error={error} />
          {!user.totp_enabled && meta?.two_fa_mode !== 'off' && (
            <div className="mt-3">
              {enrolling ? (
                <div className="max-w-sm">
                  <TwoFactorEnroll
                    onDone={(s) => {
                      setSession(s)
                      setEnrolling(false)
                    }}
                  />
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setEnrolling(true)}>Set up 2FA</Button>
              )}
            </div>
          )}
          {user.totp_enabled && !twoFARequired && (
            <form onSubmit={disable2FA} className="mt-3 flex max-w-sm gap-2">
              <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Current 6-digit code" className="mono" aria-label="Current 6-digit code" />
              <Button type="submit" variant="danger" disabled={disableCode.length !== 6}>Disable</Button>
            </form>
          )}
          {user.totp_enabled && twoFARequired && <p className="mt-2 text-xs text-zinc-500">2FA is required for your role on this instance, so it can't be turned off.</p>}
        </Card>
      </section>
      <PasswordSection />
    </div>
  )
}

function PasswordSection() {
  const { setSession } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setOk(false)
    if (next !== confirmPw) return setError("New passwords don't match")
    setBusy(true)
    try {
      await api('/api/auth/password', { method: 'POST', body: { current_password: current, new_password: next } })
      setCurrent('')
      setNext('')
      setConfirmPw('')
      setOk(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const logoutAll = async () => {
    if (!confirm('Sign out of Rexus on all your devices, including this one?')) return
    await api('/api/auth/logout-all', { method: 'POST' }).catch(() => {})
    setSession(null)
  }

  return (
    <section>
      <h2 className="mb-3 font-medium text-zinc-200">Password and sessions</h2>
      <Card className="p-4">
        <form onSubmit={submit} className="max-w-sm space-y-3">
          <div className="text-sm font-medium text-zinc-300">Change password</div>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" autoComplete="current-password" required />
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (10+ characters)" autoComplete="new-password" minLength={10} required />
          <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Repeat new password" autoComplete="new-password" required />
          <ErrorBox error={error} />
          {ok && <div className="text-sm text-emerald-400">Password changed. Your other devices were signed out.</div>}
          <Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
        </form>
        <div className="mt-5 border-t border-zinc-800 pt-4">
          <p className="mb-2 text-sm text-zinc-400">Ends every session you have open, on every device.</p>
          <Button variant="secondary" onClick={logoutAll}>Sign out of all devices</Button>
        </div>
      </Card>
    </section>
  )
}

function PreferencesTab() {
  const { prefs, set, reset } = usePrefs()
  const system = browserTimezone()
  const { meta } = useAuth()
  const look = meta?.look
  const zones = timezoneList()
  const sample = new Date().toISOString()

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        These only change how Rexus looks for you. They are saved in this browser, so they don't affect other people, and you'll set them again on another browser or device.
      </p>
      <Card className="divide-y divide-zinc-800">
        <div className="space-y-1.5 px-4 py-3">
          <Field label="Theme">
            <Select value={prefs.theme} onChange={(e) => set({ theme: e.target.value as Theme })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match my system</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-1.5 px-4 py-3">
          <Field label="Density" hint="Compact makes text and spacing a little smaller to fit more on screen.">
            <Select value={prefs.density} onChange={(e) => set({ density: e.target.value as Density })}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-1.5 px-4 py-3">
          <Field label="Timezone" hint="Used for every date and time shown in Rexus.">
            <Select value={prefs.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              <option value="">{look?.timezone ? `Default (${look.timezone})` : `Browser default (${system})`}</option>
              {zones.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="space-y-1.5 px-4 py-3">
          <Field label="Date format" hint={`Example: ${fmtTime(sample)}`}>
            <Select value={prefs.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}>
              <option value="system">Default</option>
              <option value="iso">2026-11-05 14:32 (year first)</option>
              <option value="dmy">05/11/2026 (day first)</option>
              <option value="mdy">11/5/2026 (month first)</option>
            </Select>
          </Field>
        </div>
      </Card>
      <Button variant="ghost" onClick={reset}>Reset to defaults</Button>
    </div>
  )
}
