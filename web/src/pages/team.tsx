import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type AuditRow, type Invite, type Role, type SessionResp, type User } from '../api'
import { useAuth } from '../auth'
import { AccessChoice, UserAccessModal, useVisibleProjects } from './access'
import { AuthShell, Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, fmtTime, timeAgo } from '../ui'

const roleTone = { owner: 'green', admin: 'sky', contributor: 'zinc', viewer: 'zinc' } as const

function canManageUser(actor: User, target: User) {
  if (actor.id === target.id || target.role === 'owner') return false
  if (actor.role === 'owner') return true
  return actor.role === 'admin' && (target.role === 'contributor' || target.role === 'viewer')
}

/** What a user can see, in one cell of the Users table. */
function ProjectsCell({ u, keys }: { u: User; keys: string[] }) {
  if (u.role === 'owner') return <span className="text-xs text-zinc-400">all projects</span>
  if (u.role === 'admin' && u.all_projects) return <span className="text-xs text-zinc-400">all projects</span>
  if (keys.length === 0) return <span className="text-xs text-amber-400">{u.role === 'admin' ? 'only ones they create' : 'none'}</span>
  const shown = keys.slice(0, 2).join(', ')
  return <span className="text-xs text-zinc-400" title={keys.join(', ')}>{shown}{keys.length > 2 ? ` +${keys.length - 2}` : ''}</span>
}

// ───────────────────────── users page ─────────────────────────

/** Extra sentence for a link dialog, depending on whether the server emailed the link. */
function emailNote(r: { emailed?: boolean; email_error?: string }, to: string): string {
  if (r.emailed) return ` We also emailed it to ${to}.`
  if (r.email_error) return ` Emailing it failed (${r.email_error}) — send the link yourself.`
  return ''
}

interface LinkInfo {
  title: string
  link: string
  note: string
}

export function UsersPage() {
  const { user: me, refresh } = useAuth()
  const [users, setUsers] = useState<User[] | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [grants, setGrants] = useState<Record<string, string[]>>({})
  const [editingAccess, setEditingAccess] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [linkInfo, setLinkInfo] = useState<LinkInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([
        api<{ users: User[]; grants: Record<string, string[]>; assignable_roles: Role[] }>('/api/users'),
        api<{ invites: Invite[] }>('/api/invites'),
      ])
      setUsers(u.users)
      setGrants(u.grants ?? {})
      setRoles(u.assignable_roles)
      setInvites(i.invites)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  if (!me) return null
  if (error && !users) return <ErrorBox error={error} persistent />
  if (!users) return <Spinner />

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const setRole = (u: User, role: string) => act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { role } }))
  const setStatus = (u: User, status: 'active' | 'disabled') => {
    if (status === 'disabled' && !confirm(`Disable ${u.email}? They will be logged out immediately.`)) return
    return act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { status } }))
  }
  const remove = (u: User) => {
    if (!confirm(`Remove ${u.email}? This cannot be undone.`)) return
    return act(() => api(`/api/users/${u.id}`, { method: 'DELETE' }))
  }
  const reset2FA = (u: User) => {
    if (!confirm(`Reset two-factor authentication for ${u.email}? They will be logged out and must set it up again.`)) return
    return act(() => api(`/api/users/${u.id}/reset-2fa`, { method: 'POST' }))
  }
  const resetLink = (u: User) =>
    act(async () => {
      const r = await api<{ link: string; emailed?: boolean; email_error?: string }>(`/api/users/${u.id}/reset-password`, { method: 'POST' })
      setLinkInfo({
        title: `Password reset link for ${u.email}`,
        link: r.link,
        note: 'Send this link to the user. It works once and expires in 24 hours. They choose their own password — you never see it.' + emailNote(r, u.email),
      })
    })
  const revoke = (i: Invite) => act(() => api(`/api/invites/${i.id}`, { method: 'DELETE' }))
  const newLink = (i: Invite) =>
    act(async () => {
      const r = await api<{ link: string; emailed?: boolean; email_error?: string }>('/api/invites', { method: 'POST', body: { email: i.email, role: i.role } })
      setLinkInfo({ title: `New invite link for ${i.email}`, link: r.link, note: 'The previous link no longer works. This one expires in 7 days.' + emailNote(r, i.email) })
    })

  const link = 'text-xs text-zinc-400 hover:text-zinc-100'

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Invite teammates and manage what they can do."
        actions={<Button onClick={() => setInviting(true)}>Invite user</Button>}
      />
      <ErrorBox error={error} />

      <Card className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Projects</th>
              <th className="px-4 py-2.5 font-medium">2FA</th>
              <th className="px-4 py-2.5 font-medium">Last login</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {users.map((u) => {
              const manage = canManageUser(me, u)
              return (
                <tr key={u.id} className={u.status === 'disabled' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-100">{u.name} {u.id === me.id && <span className="text-xs text-zinc-500">(you)</span>}</div>
                    <div className="text-xs text-zinc-500">{u.email}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {manage ? (
                      <div className="w-36">
                        <Select value={u.role} onChange={(e) => setRole(u, e.target.value)} className="py-1">
                          {[...new Set<string>([u.role, ...roles])].map((r) => <option key={r} value={r}>{r}</option>)}
                        </Select>
                      </div>
                    ) : (
                      <Badge tone={roleTone[u.role]}>{u.role}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5"><ProjectsCell u={u} keys={grants[u.id] ?? []} /></td>
                  <td className="px-4 py-2.5">{u.totp_enabled ? <Badge tone="green">on</Badge> : <Badge tone="amber">off</Badge>}</td>
                  <td className="px-4 py-2.5 text-zinc-400" title={fmtTime(u.last_login_at)}>
                    {u.status === 'disabled' ? <Badge tone="red">disabled</Badge> : u.last_login_at ? timeAgo(u.last_login_at) : 'never'}
                  </td>
                  <td className="px-4 py-2.5">
                    {manage && (
                      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                        <button className={link} onClick={() => setEditingAccess(u)}>Access</button>
                        <button className={link} onClick={() => resetLink(u)}>Reset password</button>
                        {u.totp_enabled && <button className={link} onClick={() => reset2FA(u)}>Reset 2FA</button>}
                        {u.status === 'active' ? (
                          <button className={link} onClick={() => setStatus(u, 'disabled')}>Disable</button>
                        ) : (
                          <button className={link} onClick={() => setStatus(u, 'active')}>Enable</button>
                        )}
                        <button className={`${link} hover:!text-red-400`} onClick={() => remove(u)}>Remove</button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 font-medium text-zinc-200">Pending invites</h2>
        {invites.length === 0 ? (
          <Empty title="No pending invites" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <tbody className="divide-y divide-zinc-800/70">
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td className="px-4 py-2.5 text-zinc-100">{i.email}</td>
                    <td className="px-4 py-2.5"><Badge tone={roleTone[i.role]}>{i.role}</Badge></td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400">{i.all_projects ? 'all projects' : i.projects.length ? i.projects.join(', ') : <span className="text-amber-400">no projects yet</span>}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-500">invited by {i.invited_by ?? 'someone'} · expires {timeAgo(i.expires_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-3">
                        <button className={link} onClick={() => newLink(i)}>New link</button>
                        <button className={`${link} hover:!text-red-400`} onClick={() => revoke(i)}>Revoke</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {me.role === 'owner' && <TransferOwnership users={users} me={me} onDone={async () => { await refresh() }} />}

      {inviting && (
        <InviteModal
          roles={roles}
          meRole={me.role}
          onClose={() => setInviting(false)}
          onCreated={(email, l, extra) => {
            setInviting(false)
            setLinkInfo({ title: `Invite link for ${email}`, link: l, note: 'Send this link to them (chat, email…). It works once and expires in 7 days. It is shown only now.' + extra })
            load()
          }}
        />
      )}
      {editingAccess && (
        <UserAccessModal
          user={editingAccess}
          me={me}
          grants={grants[editingAccess.id] ?? []}
          onClose={() => setEditingAccess(null)}
          onSaved={() => {
            setEditingAccess(null)
            load()
          }}
        />
      )}
      {linkInfo && <LinkModal info={linkInfo} onClose={() => setLinkInfo(null)} />}
    </>
  )
}

function InviteModal({ roles, meRole, onClose, onCreated }: { roles: Role[]; meRole: Role; onClose: () => void; onCreated: (email: string, link: string, extra: string) => void }) {
  const projects = useVisibleProjects()
  const [allProjects, setAllProjects] = useState(meRole === 'owner')
  const [keys, setKeys] = useState<string[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>(roles.includes('contributor') ? 'contributor' : (roles[0] ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ link: string; emailed?: boolean; email_error?: string }>('/api/invites', {
        method: 'POST',
        body: { email, role, all_projects: role === 'admin' && meRole === 'owner' && allProjects, projects: role === 'admin' && allProjects ? [] : keys },
      })
      onCreated(email, r.link, emailNote(r, email))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const hints: Record<string, string> = {
    admin: 'Manages users and everything below.',
    contributor: 'Works with projects, secrets and jobs.',
    viewer: 'Read-only: sees names and health, but no secret values.',
  }

  return (
    <Modal title="Invite user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Field>
        <Field label="Role" hint={hints[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label="Projects they can see" hint="They only see these. You can change it later with the Access button.">
          {!projects ? (
            <Spinner />
          ) : (
            <AccessChoice role={role} canSetAll={meRole === 'owner'} projects={projects} allProjects={allProjects} keys={keys} onChange={(a, k) => { setAllProjects(a); setKeys(k) }} />
          )}
        </Field>
        <p className="text-xs text-zinc-500">They'll set their own password and two-factor authentication from the link. If email is set up on the server it is emailed to them too; otherwise you share the link yourself.</p>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !role}>{busy ? 'Creating…' : 'Create invite link'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

function LinkModal({ info, onClose }: { info: LinkInfo; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.link)
      setCopied(true)
    } catch {
      // Clipboard needs HTTPS/localhost; the link is selectable below.
    }
  }
  return (
    <Modal title={info.title} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input readOnly value={info.link} className="mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <p className="text-sm text-zinc-400">{info.note}</p>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

function TransferOwnership({ users, me, onDone }: { users: User[]; me: User; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const candidates = users.filter((u) => u.id !== me.id && u.status === 'active')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = candidates.find((u) => u.id === target)
    if (!t || !confirm(`Make ${t.email} the owner? You will become an admin and lose owner-only powers.`)) return
    setBusy(true)
    setError(null)
    try {
      await api('/api/owner/transfer', { method: 'POST', body: { user_id: target, password, code } })
      await onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8">
      <h2 className="mb-3 font-medium text-zinc-200">Transfer ownership</h2>
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>Transfer ownership…</Button>
      ) : (
        <Card className="max-w-md p-4">
          <form onSubmit={submit} className="space-y-4">
            <Field label="New owner">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} required>
                <option value="">Choose a user…</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email}, {u.role})</option>)}
              </Select>
            </Field>
            <Field label="Your password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            {me.totp_enabled && (
              <Field label="2FA code">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className="mono" required />
              </Field>
            )}
            <ErrorBox error={error} />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" disabled={busy || !target}>{busy ? 'Transferring…' : 'Transfer ownership'}</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
    </section>
  )
}

// ───────────────────────── public pages: invite + password reset ─────────────────────────

export function AcceptInvitePage() {
  const { token = '' } = useParams()
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const [info, setInfo] = useState<{ email: string; role: string; company_name: string } | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ email: string; role: string; company_name: string }>(`/api/join/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setInvalid(e.message))
  }, [token])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirmPw) return setError("Passwords don't match")
    setBusy(true)
    try {
      const s = await api<SessionResp>(`/api/join/${encodeURIComponent(token)}`, { method: 'POST', body: { name, password } })
      setSession(s)
      navigate('/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (invalid) return <AuthShell title="Invite not valid" subtitle={invalid}><Link to="/" className="text-sm text-emerald-400 hover:underline">Go to login</Link></AuthShell>
  if (!info) return <Spinner />
  return (
    <AuthShell title={`Join ${info.company_name}`} subtitle={<>You've been invited as <b className="text-zinc-200">{info.role}</b>. Choose your name and password.</>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><Input value={info.email} readOnly disabled /></Field>
        <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required /></Field>
        <Field label="Password" hint="At least 10 characters."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required /></Field>
        <Field label="Repeat password"><Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Creating account…' : 'Create account'}</Button>
      </form>
    </AuthShell>
  )
}

export function ResetPasswordPage() {
  const { token = '' } = useParams()
  const { setSession } = useAuth()
  const [email, setEmail] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ email: string }>(`/api/reset/${encodeURIComponent(token)}`)
      .then((r) => setEmail(r.email))
      .catch((e) => setInvalid(e.message))
  }, [token])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirmPw) return setError("Passwords don't match")
    setBusy(true)
    try {
      await api(`/api/reset/${encodeURIComponent(token)}`, { method: 'POST', body: { password } })
      setSession(null) // the server logged this user out everywhere
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (invalid) return <AuthShell title="Link not valid" subtitle={invalid}><Link to="/" className="text-sm text-emerald-400 hover:underline">Go to login</Link></AuthShell>
  if (done) return <AuthShell title="Password updated" subtitle="You were logged out everywhere. Log in with your new password."><Link to="/" className="text-sm text-emerald-400 hover:underline">Go to login</Link></AuthShell>
  if (!email) return <Spinner />
  return (
    <AuthShell title="Choose a new password" subtitle={<>for <b className="text-zinc-200">{email}</b></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" hint="At least 10 characters."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} autoFocus required /></Field>
        <Field label="Repeat password"><Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Set password'}</Button>
      </form>
    </AuthShell>
  )
}

// ───────────────────────── audit log ─────────────────────────

export function AuditPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (query: string, before?: number) => {
    const p = new URLSearchParams({ limit: '100' })
    if (query.trim()) p.set('q', query.trim())
    if (before) p.set('before', String(before))
    try {
      const r = await api<{ entries: AuditRow[]; has_more: boolean }>(`/api/audit?${p}`)
      setRows((cur) => (before && cur ? [...cur, ...r.entries] : r.entries))
      setMore(r.has_more)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => load(q), 250)
    return () => clearTimeout(t)
  }, [q, load])

  const tone = (a: string) => (a.includes('failed') || a.includes('delete') || a.includes('disable') ? 'red' : a.startsWith('secret.') ? 'sky' : 'zinc')

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every login, secret reveal and change, newest first." />
      <div className="mb-4 max-w-sm">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by action or person — e.g. secret. or alice@" />
      </div>
      <ErrorBox error={error} />
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No matching entries" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Details</th>
                <th className="px-4 py-2.5 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {rows.map((r) => {
                const keys = Object.keys(r.details ?? {})
                const summary = keys.map((k) => `${k}: ${String(r.details[k])}`).join(' · ')
                return (
                  <tr key={r.id} className="cursor-pointer align-top hover:bg-zinc-800/30" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400" title={fmtTime(r.at)}>{timeAgo(r.at)}</td>
                    <td className="px-4 py-2.5 text-zinc-300">{r.actor}</td>
                    <td className="px-4 py-2.5"><Badge tone={tone(r.action)}>{r.action}</Badge></td>
                    <td className="max-w-xs px-4 py-2.5 text-xs text-zinc-500">
                      {open === r.id ? <pre className="whitespace-pre-wrap break-all mono">{JSON.stringify(r.details, null, 2)}</pre> : <span className="line-clamp-2">{summary}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-500 mono">{r.ip}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
      {more && rows && (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => load(q, rows[rows.length - 1].id)}>Load older entries</Button>
        </div>
      )}
    </>
  )
}
