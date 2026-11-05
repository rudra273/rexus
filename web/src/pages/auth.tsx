import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { api, type SessionResp } from '../api'
import { useAuth } from '../auth'
import { AuthShell, Button, ErrorBox, Field, Input } from '../ui'

function useSubmit() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

export function SetupPage() {
  const { refresh, setSession } = useAuth()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const { error, busy, run } = useSubmit()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      if (password !== confirm) throw new Error("Passwords don't match")
      const s = await api<SessionResp>('/api/setup', { method: 'POST', body: { code, name, email, password } })
      await refresh()
      setSession(s)
    })
  }

  return (
    <AuthShell
      title="Set up Rexus"
      subtitle="No owner exists yet. Enter the one-time setup code printed in the Rexus server logs, then create the owner account."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Setup code" hint="Shown in the server logs at startup. It changes on every restart.">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH-JKMN" className="mono uppercase" autoFocus required />
        </Field>
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label="Repeat password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create owner account'}
        </Button>
      </form>
    </AuthShell>
  )
}

export function LoginPage() {
  const { meta, setSession } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { error, busy, run } = useSubmit()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const s = await api<SessionResp>('/api/auth/login', { method: 'POST', body: { email, password } })
      setSession(s)
    })
  }

  return (
    <AuthShell title={`Log in to ${meta?.company_name ?? 'Rexus'}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <p className="mt-6 text-xs text-zinc-500">
        Lost access? The owner can recover from the server with <code className="text-zinc-400">rexus owner reset</code>.
      </p>
    </AuthShell>
  )
}

function LogoutLink() {
  const { setSession } = useAuth()
  return (
    <button
      className="mt-6 text-sm text-zinc-500 hover:text-zinc-300"
      onClick={async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
        setSession(null)
      }}
    >
      ← Use a different account
    </button>
  )
}

export function TwoFactorVerifyPage() {
  const { setSession } = useAuth()
  const [code, setCode] = useState('')
  const { error, busy, run } = useSubmit()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const s = await api<SessionResp>('/api/auth/2fa/verify', { method: 'POST', body: { code } })
      setSession(s)
    })
  }

  return (
    <AuthShell title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={submit} className="space-y-4">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className="mono text-center text-lg tracking-[0.4em]"
          autoFocus
          required
        />
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <LogoutLink />
    </AuthShell>
  )
}

/** Shared 2FA enrollment form, used on first login and from Settings. */
export function TwoFactorEnroll({ onDone }: { onDone: (s: SessionResp) => void }) {
  const [secret, setSecret] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const { error, busy, run } = useSubmit()
  const [loadError, setLoadError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Each call creates a new pending secret, so only call once
    // (React StrictMode runs effects twice in dev).
    if (started.current) return
    started.current = true
    api<{ secret: string; otpauth_url: string }>('/api/auth/2fa/setup', { method: 'POST' })
      .then(async (r) => {
        setSecret(r.secret)
        setQr(await QRCode.toDataURL(r.otpauth_url, { margin: 1, width: 200 }))
      })
      .catch((e) => setLoadError(e.message))
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const s = await api<SessionResp>('/api/auth/2fa/enable', { method: 'POST', body: { code } })
      onDone(s)
    })
  }

  if (loadError) return <ErrorBox error={loadError} />
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-400">
        <li>Open an authenticator app (Google Authenticator, Authy, 1Password…).</li>
        <li>Scan the QR code, or enter the key manually.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      <div className="flex justify-center rounded-lg bg-white p-3">
        {qr ? <img src={qr} alt="2FA QR code" width={200} height={200} /> : <div className="h-[200px] w-[200px]" />}
      </div>
      {secret && (
        <div className="break-all rounded-md bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-400 mono">{secret}</div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className="mono text-center text-lg tracking-[0.4em]"
          required
        />
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy || code.length !== 6 || !secret} className="w-full">
          {busy ? 'Enabling…' : 'Enable 2FA'}
        </Button>
      </form>
    </div>
  )
}

export function TwoFactorEnrollPage() {
  const { setSession } = useAuth()
  return (
    <AuthShell title="Set up two-factor authentication" subtitle="2FA is required on this Rexus instance before you can continue.">
      <TwoFactorEnroll onDone={setSession} />
      <LogoutLink />
    </AuthShell>
  )
}
