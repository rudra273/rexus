import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, canWrite, type Environment, type Project, type Secret, type SecretVersion } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cx, fmtTime, timeAgo } from '../ui'

export function ExpiryBadge({ secret }: { secret: Pick<Secret, 'expires_on' | 'days_left'> }) {
  if (!secret.expires_on || secret.days_left == null) return <span className="text-xs text-zinc-600">no expiry</span>
  const d = secret.days_left
  if (d < 0) return <Badge tone="red">expired {-d}d ago</Badge>
  if (d <= 7) return <Badge tone="red">{d === 0 ? 'expires today' : `expires in ${d}d`}</Badge>
  if (d <= 30) return <Badge tone="amber">expires in {d}d</Badge>
  return <span className="text-xs text-zinc-400">expires {secret.expires_on}</span>
}

// ───────────────────────── project page: secrets by environment ─────────────────────────

export function ProjectVault({ project }: { project: Project }) {
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const [envs, setEnvs] = useState<Environment[] | null>(null)
  const [envId, setEnvId] = useState('')
  const [secrets, setSecrets] = useState<Secret[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ existing?: Secret } | null>(null)
  const [addingEnv, setAddingEnv] = useState(false)
  const [newEnv, setNewEnv] = useState('')

  const loadEnvs = useCallback(
    async (select?: string) => {
      try {
        const r = await api<{ environments: Environment[] }>(`/api/projects/${encodeURIComponent(project.key)}/environments`)
        setEnvs(r.environments)
        setEnvId((cur) => select ?? (r.environments.some((e) => e.id === cur) ? cur : (r.environments[0]?.id ?? '')))
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [project.key],
  )
  useEffect(() => {
    loadEnvs()
  }, [loadEnvs])

  const loadSecrets = useCallback(async () => {
    if (!envId) return setSecrets([])
    try {
      const r = await api<{ secrets: Secret[] }>(`/api/secrets?environment=${envId}`)
      setSecrets(r.secrets)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [envId])
  useEffect(() => {
    setSecrets(null)
    loadSecrets()
  }, [loadSecrets])

  const refresh = () => {
    loadSecrets()
    loadEnvs()
  }
  const active = envs?.find((e) => e.id === envId)

  const addEnv = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const r = await api<{ environment: Environment }>(`/api/projects/${encodeURIComponent(project.key)}/environments`, {
        method: 'POST',
        body: { name: newEnv },
      })
      setNewEnv('')
      setAddingEnv(false)
      await loadEnvs(r.environment.id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const renameEnv = async () => {
    if (!active) return
    const name = prompt(`Rename environment "${active.name}" to:`, active.name)
    if (!name || name === active.name) return
    setError(null)
    try {
      await api(`/api/environments/${active.id}`, { method: 'PATCH', body: { name } })
      await loadEnvs()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const deleteEnv = async () => {
    if (!active || !confirm(`Delete the empty environment "${active.name}"?`)) return
    setError(null)
    try {
      await api(`/api/environments/${active.id}`, { method: 'DELETE' })
      await loadEnvs('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-zinc-200">Secrets</h2>
        {writable && envId && <Button variant="secondary" onClick={() => setForm({})}>Add secret</Button>}
      </div>
      <ErrorBox error={error} />
      {!envs ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 mt-2 flex flex-wrap items-center gap-1.5">
            {envs.map((e) => (
              <button
                key={e.id}
                onClick={() => setEnvId(e.id)}
                className={cx(
                  'rounded-md border px-3 py-1.5 text-sm',
                  e.id === envId ? 'border-emerald-600 bg-emerald-950/40 text-emerald-200' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200',
                )}
              >
                {e.name} <span className="ml-1 text-xs text-zinc-500">{e.secret_count}</span>
              </button>
            ))}
            {writable &&
              (addingEnv ? (
                <form onSubmit={addEnv} className="flex items-center gap-1.5">
                  <div className="w-36">
                    <Input value={newEnv} onChange={(e) => setNewEnv(e.target.value.toLowerCase())} placeholder="e.g. preview" autoFocus className="py-1.5" />
                  </div>
                  <Button type="submit" variant="secondary" className="py-1.5">Add</Button>
                  <Button type="button" variant="ghost" className="py-1.5" onClick={() => setAddingEnv(false)}>Cancel</Button>
                </form>
              ) : (
                <button onClick={() => setAddingEnv(true)} className="px-2 text-sm text-emerald-400 hover:text-emerald-300">+ Environment</button>
              ))}
            {writable && active && (
              <span className="ml-auto flex gap-3 text-xs text-zinc-500">
                <button onClick={renameEnv} className="hover:text-zinc-200">Rename</button>
                <button onClick={deleteEnv} className="hover:text-red-400">Delete</button>
              </span>
            )}
          </div>

          {!secrets ? (
            <Spinner />
          ) : secrets.length === 0 ? (
            <Empty title={`No secrets in ${active?.name ?? 'this environment'}`}>
              {writable ? 'Add API keys and credentials. Values are encrypted before they reach the database.' : 'Nothing has been stored here yet.'}
            </Empty>
          ) : (
            <div className="space-y-2">
              {secrets.map((s) => (
                <SecretRow key={s.id} secret={s} writable={writable} onEdit={() => setForm({ existing: s })} onChanged={refresh} />
              ))}
            </div>
          )}
        </>
      )}

      {form && envId && (
        <SecretForm
          environmentId={envId}
          existing={form.existing}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}

function SecretRow({ secret, writable, onEdit, onChanged }: { secret: Secret; writable: boolean; onEdit: () => void; onChanged: () => void }) {
  const [value, setValue] = useState<{ text: string; label: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [history, setHistory] = useState<SecretVersion[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // After an edit or restore the value on screen is stale — hide it.
  useEffect(() => setValue(null), [secret.current_version])

  // A revealed value hides itself after 30 seconds.
  const show = (text: string, label: string) => {
    setValue({ text, label })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setValue(null), 30_000)
  }
  const fetchValue = (purpose: 'reveal' | 'copy', version?: number) =>
    api<{ value: string; version: number }>(`/api/secrets/${secret.id}/reveal`, { method: 'POST', body: { purpose, version } })

  const reveal = async (version?: number) => {
    setErr(null)
    setMsg(null)
    try {
      const r = await fetchValue('reveal', version)
      show(r.value, `v${r.version}`)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const copy = async () => {
    setErr(null)
    setMsg(null)
    try {
      const r = await fetchValue('copy')
      try {
        await navigator.clipboard.writeText(r.value)
        setMsg('Copied to clipboard')
        setTimeout(() => setMsg(null), 2500)
      } catch {
        // Clipboard needs HTTPS or localhost; fall back to showing the value.
        show(r.value, `v${r.version}`)
        setMsg('Clipboard is unavailable on this connection — value revealed instead')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const loadHistory = async () => {
    try {
      const r = await api<{ versions: SecretVersion[] }>(`/api/secrets/${secret.id}/versions`)
      setHistory(r.versions)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const toggleHistory = () => {
    setShowHistory(!showHistory)
    if (!showHistory) loadHistory()
  }

  const restore = async (version: number) => {
    if (!confirm(`Restore the value from v${version}? This saves it as a new version.`)) return
    setErr(null)
    try {
      await api(`/api/secrets/${secret.id}/restore`, { method: 'POST', body: { version } })
      setValue(null)
      await loadHistory()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete "${secret.name}" and all ${secret.current_version} version(s)? This cannot be undone.`)) return
    try {
      await api(`/api/secrets/${secret.id}`, { method: 'DELETE' })
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const link = 'text-xs text-zinc-400 hover:text-zinc-100'
  const fields = Object.entries(secret.custom_fields)

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-100 mono">{secret.name}</span>
            <Badge>v{secret.current_version}</Badge>
            <ExpiryBadge secret={secret} />
            {secret.tags.map((t) => (
              <Badge key={t} tone="sky">{t}</Badge>
            ))}
          </div>
          <div className="mt-1 text-xs text-zinc-500">updated {timeAgo(secret.updated_at)}{secret.updated_by ? ` by ${secret.updated_by}` : ''}</div>
        </div>
        {writable && (
          <div className="flex flex-wrap items-center gap-3">
            {value ? <button className={link} onClick={() => setValue(null)}>Hide</button> : <button className={link} onClick={() => reveal()}>Reveal</button>}
            <button className={link} onClick={copy}>Copy</button>
            <button className={link} onClick={toggleHistory}>{showHistory ? 'Hide history' : 'History'}</button>
            <button className={link} onClick={onEdit}>Edit</button>
            <button className={cx(link, 'hover:!text-red-400')} onClick={remove}>Delete</button>
          </div>
        )}
      </div>

      {value && (
        <div className="mt-3">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-emerald-200 mono">{value.text}</pre>
          <div className="mt-1 text-xs text-zinc-500">Showing {value.label} · hides automatically after 30 seconds</div>
        </div>
      )}
      {msg && <div className="mt-2 text-xs text-emerald-400">{msg}</div>}
      <ErrorBox error={err} />

      {secret.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-400">{secret.notes}</p>}
      {fields.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="break-all text-zinc-300">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {showHistory && (
        <div className="mt-3 rounded-md border border-zinc-800">
          {!history ? (
            <div className="p-3 text-xs text-zinc-500">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-800/70">
                {history.map((v) => (
                  <tr key={v.version}>
                    <td className="px-3 py-2 text-zinc-300 mono">v{v.version}</td>
                    <td className="px-3 py-2 text-zinc-500" title={fmtTime(v.created_at)}>{timeAgo(v.created_at)}{v.created_by ? ` · ${v.created_by}` : ''}</td>
                    <td className="px-3 py-2 text-right">
                      {v.current ? <Badge tone="green">current</Badge> : (
                        <span className="flex justify-end gap-3">
                          <button className={link} onClick={() => reveal(v.version)}>Reveal</button>
                          <button className={link} onClick={() => restore(v.version)}>Restore</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  )
}

function SecretForm({ environmentId, existing, onClose, onSaved }: { environmentId: string; existing?: Secret; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [expires, setExpires] = useState(existing?.expires_on ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [tags, setTags] = useState(existing?.tags.join(', ') ?? '')
  const [fields, setFields] = useState(Object.entries(existing?.custom_fields ?? {}).map(([n, v]) => ({ name: n, value: v })))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = {
      name,
      expires_on: expires || null,
      notes,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      custom_fields: Object.fromEntries(fields.filter((f) => f.name.trim()).map((f) => [f.name.trim(), f.value])),
    }
    if (value) body.value = value
    try {
      if (existing) await api(`/api/secrets/${existing.id}`, { method: 'PATCH', body })
      else await api(`/api/environments/${environmentId}/secrets`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const masked = (showValue ? {} : { WebkitTextSecurity: 'disc' }) as CSSProperties

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add secret'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="Letters, numbers, dots, dashes and underscores — e.g. STRIPE_SECRET_KEY">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mono" autoFocus required />
        </Field>
        <Field
          label={existing ? 'New value' : 'Value'}
          hint={existing ? `Leave blank to keep the current value (v${existing.current_version}). A new value is saved as v${existing.current_version + 1}.` : 'Encrypted before it is stored.'}
        >
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={3}
            style={masked}
            className="mono"
            autoComplete="off"
            spellCheck={false}
            required={!existing}
          />
        </Field>
        <label className="-mt-2 flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={showValue} onChange={(e) => setShowValue(e.target.checked)} className="accent-emerald-500" />
          Show value while typing
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Expiry date (optional)" hint="You'll be reminded before it expires.">
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <Field label="Tags (optional)" hint="Comma-separated, e.g. payment, third-party">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>

        <Field label="Notes (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="e.g. rotate via the Stripe dashboard" />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-300">Custom fields</span>
            <button type="button" className="text-xs text-emerald-400 hover:text-emerald-300" onClick={() => setFields([...fields, { name: '', value: '' }])}>+ Add field</button>
          </div>
          {fields.length === 0 ? (
            <p className="text-xs text-zinc-500">e.g. provider, owner, dashboard URL. These are <b>not</b> encrypted — don't put secrets here.</p>
          ) : (
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <div className="w-2/5 shrink-0">
                    <Input value={f.name} placeholder="Field" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </div>
                  <Input value={f.value} placeholder="Value" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button type="button" variant="ghost" onClick={() => setFields(fields.filter((_, j) => j !== i))} aria-label="Remove field">✕</Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save changes' : 'Add secret'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

// ───────────────────────── global vault page: search across projects ─────────────────────────

export function VaultPage() {
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [expiring, setExpiring] = useState('')
  const [secrets, setSecrets] = useState<Secret[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams()
      if (q.trim()) p.set('q', q.trim())
      if (tag.trim()) p.set('tag', tag.trim().toLowerCase())
      if (expiring) p.set('expiring', expiring)
      api<{ secrets: Secret[] }>(`/api/secrets?${p}`)
        .then((r) => {
          setSecrets(r.secrets)
          setError(null)
        })
        .catch((e) => setError(e.message))
    }, 250)
    return () => clearTimeout(t)
  }, [q, tag, expiring])

  const allTags = [...new Set((secrets ?? []).flatMap((s) => s.tags))].sort()

  return (
    <>
      <PageHeader title="Vault" subtitle="Search secrets across all projects. Open a project to reveal, edit or restore a value." />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or project…" />
        <div>
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Filter by tag" list="vault-tags" />
          <datalist id="vault-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        <Select value={expiring} onChange={(e) => setExpiring(e.target.value)}>
          <option value="">Any expiry</option>
          <option value="7">Expiring within 7 days</option>
          <option value="30">Expiring within 30 days</option>
          <option value="90">Expiring within 90 days</option>
        </Select>
      </div>
      <ErrorBox error={error} />
      {!secrets ? (
        <Spinner />
      ) : secrets.length === 0 ? (
        <Empty title="No secrets found">Try a different search, or add secrets from a project page.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Secret</th>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Env</th>
                <th className="px-4 py-2.5 font-medium">Tags</th>
                <th className="px-4 py-2.5 font-medium">Expiry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {secrets.map((s) => (
                <tr key={s.id} className="hover:bg-zinc-800/30">
                  <td className="px-4 py-2.5 text-zinc-100 mono">{s.name}</td>
                  <td className="px-4 py-2.5"><Link to={`/projects/${s.project_key}`} className="text-zinc-300 hover:underline">{s.project_name}</Link></td>
                  <td className="px-4 py-2.5"><Badge>{s.environment}</Badge></td>
                  <td className="px-4 py-2.5"><span className="flex flex-wrap gap-1">{s.tags.map((t) => <Badge key={t} tone="sky">{t}</Badge>)}</span></td>
                  <td className="px-4 py-2.5"><ExpiryBadge secret={s} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}
