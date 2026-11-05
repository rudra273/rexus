import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, isAdmin, type User } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, ErrorBox, Input, PageHeader } from '../ui'
import { TwoFactorEnroll } from './auth'

interface InstanceSettings {
  company_name: string
  base_url: string
  version: string
  toggles: Record<string, string>
}

export function SettingsPage() {
  const { user, meta, setSession } = useAuth()
  const [instance, setInstance] = useState<InstanceSettings | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [disableCode, setDisableCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (user && isAdmin(user.role)) {
      api<InstanceSettings>('/api/settings').then(setInstance).catch((e) => setError(e.message))
    }
  }, [user])

  if (!user) return null
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
    <>
      <PageHeader title="Settings" />
      <ErrorBox error={error} />

      <section className="mt-4 max-w-2xl">
        <h2 className="mb-3 font-medium text-zinc-200">Your account</h2>
        <Card className="divide-y divide-zinc-800">
          <Row label="Name" value={user.name} />
          <Row label="Email" value={user.email} />
          <Row label="Role" value={<Badge tone="green">{user.role}</Badge>} />
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Two-factor authentication</span>
              {user.totp_enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">off</Badge>}
            </div>
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
                <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Current 6-digit code" className="mono" />
                <Button type="submit" variant="danger" disabled={disableCode.length !== 6}>Disable</Button>
              </form>
            )}
            {user.totp_enabled && twoFARequired && <p className="mt-2 text-xs text-zinc-500">2FA is required for your role on this instance.</p>}
          </div>
        </Card>
      </section>

      {instance && (
        <section className="mt-8 max-w-2xl">
          <h2 className="mb-1 font-medium text-zinc-200">Instance</h2>
          <p className="mb-3 text-sm text-zinc-500">
            Toggles are set with env vars and are read-only here. Change them in <code>.env</code> and restart Rexus.
          </p>
          <Card className="divide-y divide-zinc-800">
            <Row label="Company" value={instance.company_name} />
            <Row label="Base URL" value={<span className="mono">{instance.base_url}</span>} />
            <Row label="Version" value={<span className="mono">{instance.version}</span>} />
            {Object.entries(instance.toggles)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => (
                <Row key={k} label={<span className="mono text-xs">{k}</span>} value={<span className="mono">{v}</span>} />
              ))}
          </Card>
        </section>
      )}
    </>
  )
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="truncate text-right text-zinc-200">{value}</span>
    </div>
  )
}
