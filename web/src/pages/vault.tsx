import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, canWrite, isAdmin, type Environment, type Project, type Secret, type SecretVersion, type Service, type ServiceFilter } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cx, fmtTime, timeAgo } from '../ui'
import { ServiceBadge, ServiceSelect, serviceQuery, useServices } from './services'
import { BulkAddModal, ConfirmModal, DeleteAllModal } from './bulk_secrets'

export function ExpiryBadge({ secret }: { secret: Pick<Secret, 'expires_on' | 'days_left'> }) {
  if (!secret.expires_on || secret.days_left == null) return <span className="text-xs text-zinc-600">no expiry</span>
  const d = secret.days_left
  if (d < 0) return <Badge tone="red">expired {-d}d ago</Badge>
  if (d <= 7) return <Badge tone="red">{d === 0 ? 'expires today' : `expires in ${d}d`}</Badge>
  if (d <= 30) return <Badge tone="amber">expires in {d}d</Badge>
  return <span className="text-xs text-zinc-400">expires {secret.expires_on}</span>
}

// ───────────────────────── project page: secrets by environment ─────────────────────────

function CopyAllSecrets({ envId, name, scope }: { envId: string; name: string; scope: ServiceFilter }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const copy = async () => {
    setMessage('')
    setError('')
    if (!navigator.clipboard) {
      setError('Clipboard unavailable. Open Vault over HTTPS or localhost.')
      return
    }
    setBusy(true)
    const request = api<{ content: string; count: number; format: 'dotenv' | 'json' }>(
      `/api/environments/${envId}/secrets/copy-all${serviceQuery(scope, '?')}`,
      { method: 'POST' },
    )
    try {
      // Start the clipboard write inside the click gesture, before the fetch finishes.
      // Safari otherwise rejects the write after the request resolves.
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        const blob = request.then(({ content }) => new Blob([content], { type: 'text/plain' }))
        void blob.catch(() => {}) // A denied clipboard write may never consume the promise.
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      } else {
        await navigator.clipboard.writeText((await request).content)
      }
      const { count, format } = await request
      setMessage(`Copied ${count} ${name} ${count === 1 ? 'secret' : 'secrets'} as ${format === 'dotenv' ? '.env' : 'JSON'}`)
    } catch {
      try {
        await request
        setError('Could not write to the clipboard. Check your browser permissions and try again.')
      } catch (err) {
        setError((err as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" className="py-1 text-xs" disabled={busy} onClick={copy}>
        <Icon name="copy" /> {busy ? 'Copying…' : `Copy all · ${name}`}
      </Button>
      {message && <span role="status" className="text-xs text-emerald-300">{message}</span>}
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </div>
  )
}

export function ProjectVault({ project, services, scope, onChanged }: { project: Project; services: Service[]; scope: ServiceFilter; onChanged: () => void }) {
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const admin = !!user && isAdmin(user.role) // adding, renaming and deleting environments
  const [envs, setEnvs] = useState<Environment[] | null>(null)
  const [envId, setEnvId] = useState('')
  const [secrets, setSecrets] = useState<Secret[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ existing?: Secret } | null>(null)
  const [bulk, setBulk] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
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
      const r = await api<{ secrets: Secret[] }>(`/api/secrets?environment=${envId}${serviceQuery(scope)}`)
      setSecrets(r.secrets)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [envId, scope])
  useEffect(() => {
    setSecrets(null)
    loadSecrets()
  }, [loadSecrets])

  const refresh = () => {
    loadSecrets()
    loadEnvs()
    onChanged() // service secret counts
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
        {writable && envId && (
          <div className="flex flex-wrap items-center gap-2">
            {active && secrets?.some((s) => s.environment_id === active.id) && (
              <CopyAllSecrets key={`${active.id}:${scope}`} envId={active.id} name={active.name} scope={scope} />
            )}
            {admin && (secrets?.length ?? 0) > 0 && (
              <Button variant="ghost" className="text-red-400 hover:!text-red-300" onClick={() => setDeletingAll(true)}>Delete all</Button>
            )}
            <Button variant="secondary" onClick={() => setBulk(true)}>Add multiple</Button>
            <Button variant="secondary" onClick={() => setForm({})}>Add secret</Button>
          </div>
        )}
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
            {admin &&
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
            {admin && active && (
              <span className="ml-auto flex gap-3 text-xs text-zinc-500">
                <button onClick={renameEnv} className="hover:text-zinc-200">Rename</button>
                <button onClick={deleteEnv} className="hover:text-red-400">Delete</button>
              </span>
            )}
          </div>

          {!secrets ? (
            <Spinner />
          ) : secrets.length === 0 ? (
            <Empty title={`No secrets ${scope ? 'here ' : ''}in ${active?.name ?? 'this environment'}`}>
              {writable ? 'Add API keys and credentials. Values are encrypted before they reach the database.' : 'Nothing has been stored here yet.'}
            </Empty>
          ) : (
            <div className="space-y-2">
              {secrets.map((s) => (
                <SecretRow key={s.id} secret={s} services={services} showService={!scope} writable={writable} onEdit={() => setForm({ existing: s })} onChanged={refresh} />
              ))}
            </div>
          )}
        </>
      )}

      {form && envId && (
        <SecretForm
          environmentId={envId}
          environments={envs ?? undefined}
          projectKey={project.key}
          services={services}
          defaultService={scope && scope !== '-' ? scope : ''}
          existing={form.existing}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            refresh()
          }}
        />
      )}
      {bulk && envId && active && (
        <BulkAddModal
          environments={envs ?? []}
          initialEnvId={envId}
          services={services}
          defaultService={scope && scope !== '-' ? scope : ''}
          onClose={() => setBulk(false)}
          onDone={() => {
            setBulk(false)
            refresh()
          }}
        />
      )}
      {deletingAll && envId && active && (
        <DeleteAllModal
          choices={[{ id: envId, name: active.name, count: secrets?.length ?? 0 }]}
          initialEnvId={envId}
          scope={scope}
          scopeLabel={scope === '' ? (services.length > 0 ? 'all services and the project itself' : 'the project') : scope === '-' ? 'the project itself' : `service ${services.find((s) => s.id === scope)?.key ?? ''}`}
          onClose={() => setDeletingAll(false)}
          onDone={() => {
            setDeletingAll(false)
            refresh()
          }}
        />
      )}
    </section>
  )
}

export function SecretRow({ secret, services, showService, showProject, writable, onEdit, onChanged }: { secret: Secret; services: Service[]; showService: boolean; showProject?: boolean; writable: boolean; onEdit: () => void; onChanged: () => void }) {
  const [moving, setMoving] = useState(false)
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

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const remove = async () => {
    await api(`/api/secrets/${secret.id}`, { method: 'DELETE' })
    setConfirmingDelete(false)
    onChanged()
  }

  const ib = 'flex rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
  const link = 'text-xs text-zinc-400 hover:text-zinc-100'
  const fields = Object.entries(secret.custom_fields)

  return (
    <Card className={cx('border-l-[3px] px-4 py-2.5', expiryAccent(secret))}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium leading-6 text-zinc-100 mono">{secret.name}</span>
            {showProject && <Link to={`/projects/${secret.project_key}`} className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline">{secret.project_name}</Link>}
            {showService && <ServiceBadge r={secret} />}
            <Badge>{secret.environment}</Badge>
            <Badge>v{secret.current_version}</Badge>
            <ExpiryBadge secret={secret} />
            {secret.tags.map((t) => (
              <Badge key={t} tone="sky">{t}</Badge>
            ))}
          </div>
        </div>
        {writable && (
          <div className="flex items-center gap-0.5">
            {value ? (
              <button className={ib} title="Hide" aria-label="Hide" onClick={() => setValue(null)}><Icon name="eyeoff" /></button>
            ) : (
              <button className={ib} title="Reveal" aria-label="Reveal" onClick={() => reveal()}><Icon name="eye" /></button>
            )}
            <button className={ib} title="Copy value" aria-label="Copy value" onClick={copy}><Icon name="copy" /></button>
            <button className={cx(ib, showHistory && 'bg-zinc-800 text-zinc-100')} title={`History · updated ${timeAgo(secret.updated_at)}${secret.updated_by ? ` by ${secret.updated_by}` : ''}`} aria-label="History" onClick={toggleHistory}><Icon name="history" /></button>
            <button className={ib} title="Edit" aria-label="Edit" onClick={onEdit}><Icon name="edit" /></button>
            {(services.length > 0 || secret.service_id) && <button className={ib} title="Move" aria-label="Move" onClick={() => setMoving(true)}><Icon name="move" /></button>}
            <button className={cx(ib, 'hover:!text-red-400')} title="Delete" aria-label="Delete" onClick={() => setConfirmingDelete(true)}><Icon name="trash" /></button>
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
      {moving && (
        <MoveSecret
          secret={secret}
          services={services}
          onClose={() => setMoving(false)}
          onMoved={() => {
            setMoving(false)
            onChanged()
          }}
        />
      )}
      {confirmingDelete && (
        <ConfirmModal title="Delete secret" confirmLabel="Delete secret" danger onConfirm={remove} onClose={() => setConfirmingDelete(false)}>
          Delete <span className="mono font-medium text-zinc-100">{secret.name}</span>
          {secret.current_version > 1 ? ` and its ${secret.current_version} versions` : ''}? This can’t be undone.
        </ConfirmModal>
      )}
    </Card>
  )
}

/** Moves a secret between the project itself and its services. Versions and history stay with it. */
function MoveSecret({ secret, services, onClose, onMoved }: { secret: Secret; services: Service[]; onClose: () => void; onMoved: () => void }) {
  const [to, setTo] = useState(secret.service_id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/api/secrets/${secret.id}/move`, { method: 'POST', body: { service_id: to } })
      onMoved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Move ${secret.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-zinc-400">
          Stays in <b>{secret.environment}</b>. Its value, all {secret.current_version} version(s) and history move with it. API paths change:
          a project secret is read at <code>/secrets/…</code>, a service secret at <code>/services/&lt;key&gt;/secrets/…</code>.
        </p>
        <Field label="Move to">
          <ServiceSelect services={services} value={to} onChange={setTo} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || to === (secret.service_id ?? '')}>{busy ? 'Moving…' : 'Move secret'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

export function SecretForm({ environmentId, environments, projectKey, services: initialServices, defaultService, existing, onClose, onSaved }: { environmentId: string; environments?: Environment[]; projectKey?: string; services: Service[]; defaultService: string; existing?: Secret; onClose: () => void; onSaved: () => void }) {
  const [envId, setEnvId] = useState(environmentId)
  const [services, setServices] = useState(initialServices)
  const pkey = projectKey ?? existing?.project_key ?? ''
  const [newSvc, setNewSvc] = useState<{ name: string; key: string; touched: boolean } | null>(null)
  const [svcBusy, setSvcBusy] = useState(false)
  const [svcError, setSvcError] = useState<string | null>(null)
  const [serviceId, setServiceId] = useState(existing?.service_id ?? defaultService)
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
    if (!existing) body.service_id = serviceId
    try {
      if (existing) await api(`/api/secrets/${existing.id}`, { method: 'PATCH', body })
      else await api(`/api/environments/${envId}/secrets`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const createService = async () => {
    if (!newSvc || !pkey) return
    setSvcBusy(true)
    setSvcError(null)
    try {
      const r = await api<{ service: Service }>(`/api/projects/${encodeURIComponent(pkey)}/services`, {
        method: 'POST',
        body: { name: newSvc.name, key: newSvc.key, description: '', repository_url: '', root_directory: '' },
      })
      setServices((cur) => [...cur, r.service])
      setServiceId(r.service.id)
      setNewSvc(null)
    } catch (err) {
      setSvcError((err as Error).message)
    } finally {
      setSvcBusy(false)
    }
  }
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40).replace(/-+$/, '')

  const masked = (showValue ? {} : { WebkitTextSecurity: 'disc' }) as CSSProperties

  const hasMore = !!existing && (!!existing.notes || fields.length > 0)
  const [more, setMore] = useState(hasMore)
  const label = 'text-sm font-medium text-zinc-300'

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add secret'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mono" placeholder="e.g. STRIPE_SECRET_KEY" title="Letters, numbers, dots, dashes and underscores" autoFocus required />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className={label}>Environment</span>
            {existing || !environments || environments.length === 0 ? (
              <Select disabled>
                <option>{existing?.environment ?? environments?.find((e) => e.id === envId)?.name ?? '—'}</option>
              </Select>
            ) : (
              <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className={label}>Service</span>
              {!existing && pkey && !newSvc && (
                <button type="button" className="text-xs text-emerald-400 hover:text-emerald-300" onClick={() => setNewSvc({ name: '', key: '', touched: false })}>+ New service</button>
              )}
            </div>
            <ServiceSelect services={services} value={serviceId} onChange={setServiceId} disabled={!!existing} />
          </div>
        </div>
        {existing && <p className="-mt-2 text-xs text-zinc-500">Environment and service are fixed here — use “Move” on the card to change the service.</p>}

        {newSvc && (
          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input value={newSvc.name} placeholder="Service name, e.g. Backend" autoFocus onChange={(e) => setNewSvc({ ...newSvc, name: e.target.value, key: newSvc.touched ? newSvc.key : slug(e.target.value) })} />
              <Input value={newSvc.key} placeholder="key, e.g. backend" className="mono" onChange={(e) => setNewSvc({ ...newSvc, key: e.target.value.toLowerCase(), touched: true })} />
            </div>
            <ErrorBox error={svcError} />
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="py-1.5" disabled={svcBusy || !newSvc.name || newSvc.key.length < 2} onClick={createService}>{svcBusy ? 'Creating…' : 'Create service'}</Button>
              <Button type="button" variant="ghost" className="py-1.5" onClick={() => setNewSvc(null)}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className={label}>{existing ? 'New value' : 'Value'}</span>
            <span className="flex items-center gap-2 text-xs text-zinc-500">
              <span>Encrypted before it is stored</span>
              <button type="button" onClick={() => setShowValue(!showValue)} title={showValue ? 'Hide value' : 'Show value'} aria-label={showValue ? 'Hide value' : 'Show value'} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
                <Icon name={showValue ? 'eyeoff' : 'eye'} />
              </button>
            </span>
          </div>
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={3}
            style={masked}
            className="mono"
            placeholder={existing ? `Leave blank to keep the current value (v${existing.current_version})` : 'Paste the secret value'}
            autoComplete="off"
            spellCheck={false}
            required={!existing}
          />
          {existing && value && <p className="text-xs text-zinc-500">Saved as v{existing.current_version + 1}.</p>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Expiry date">
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <Field label="Tags">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="payment, third-party" />
          </Field>
        </div>

        <div>
          <button type="button" onClick={() => setMore(!more)} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200" aria-expanded={more}>
            <Icon name="chevron" className={cx('h-3 w-3 transition-transform', more && 'rotate-90')} />
            Notes &amp; custom fields
            {!more && (notes || fields.length > 0) && <span className="text-xs text-zinc-500">· filled</span>}
          </button>
          {more && (
            <div className="mt-3 space-y-4">
              <Field label="Notes">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="e.g. rotate via the Stripe dashboard" />
              </Field>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className={label}>Custom fields <span className="text-xs font-normal text-zinc-500">· not encrypted</span></span>
                  <button type="button" className="text-xs text-emerald-400 hover:text-emerald-300" onClick={() => setFields([...fields, { name: '', value: '' }])}>+ Add field</button>
                </div>
                {fields.length === 0 ? (
                  <p className="text-xs text-zinc-500">e.g. provider, owner, dashboard URL. Don’t put secrets here.</p>
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
            </div>
          )}
        </div>

        <ErrorBox error={error} />
        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save changes' : 'Add secret'}</Button>
        </div>
      </form>
    </Modal>
  )
}

// ───────────────────────── global vault page: folder tree + list + detail ─────────────────────────

type Sel =
  | { kind: 'all' }
  | { kind: 'expiring' }
  | { kind: 'recent' }
  | { kind: 'project'; project: string }
  | { kind: 'service'; project: string; service: string } // service '' = project-level secrets

interface ProjectNode {
  key: string
  name: string
  secrets: Secret[]
  services: Map<string, { id: string; name: string; secrets: Secret[] }>
}

const PROJECT_LEVEL = ''

function buildTree(secrets: Secret[]): ProjectNode[] {
  const m = new Map<string, ProjectNode>()
  for (const s of secrets) {
    let p = m.get(s.project_key)
    if (!p) m.set(s.project_key, (p = { key: s.project_key, name: s.project_name, secrets: [], services: new Map() }))
    p.secrets.push(s)
    const sk = s.service_key ?? PROJECT_LEVEL
    let sv = p.services.get(sk)
    if (!sv) p.services.set(sk, (sv = { id: s.service_id ?? '', name: s.service_name ?? 'Project-level', secrets: [] }))
    sv.secrets.push(s)
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function matches(sel: Sel, s: Secret): boolean {
  switch (sel.kind) {
    case 'all':
    case 'recent':
      return true
    case 'expiring':
      return s.days_left != null && s.days_left <= 30
    case 'project':
      return s.project_key === sel.project
    case 'service':
      return s.project_key === sel.project && (s.service_key ?? PROJECT_LEVEL) === sel.service
  }
}

type IconName = 'folder' | 'box' | 'key' | 'alert' | 'clock' | 'chevron' | 'layers' | 'eye' | 'eyeoff' | 'copy' | 'history' | 'edit' | 'move' | 'trash'
const ICON_PATHS: Record<IconName, React.ReactNode> = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9m-3 3 3 3m-6-0 2 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4m0 3h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeoff: (
    <>
      <path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 4M6.6 7.6A16 16 0 0 0 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />,
  move: <path d="M5 12h14m-5-5 5 5-5 5M5 5v14" />,
  trash: <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 5v6m4-6v6" />,
}
function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cx('inline-block h-4 w-4 shrink-0', className)} aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  )
}

/** Row accent by urgency: red = expired or ≤7d, amber = ≤30d. */
function expiryAccent(s: Pick<Secret, 'days_left'>): string {
  if (s.days_left == null) return 'border-l-transparent'
  if (s.days_left <= 7) return 'border-l-red-500'
  if (s.days_left <= 30) return 'border-l-amber-400'
  return 'border-l-transparent'
}

function worstExpiry(list: Secret[]): 'red' | 'amber' | null {
  let w: 'red' | 'amber' | null = null
  for (const s of list) {
    if (s.days_left == null) continue
    if (s.days_left <= 7) return 'red'
    if (s.days_left <= 30) w = 'amber'
  }
  return w
}

function ExpiryDot({ list }: { list: Secret[] }) {
  const w = worstExpiry(list)
  if (!w) return null
  return <span title={w === 'red' ? 'Has expired or soon-to-expire secrets' : 'Has secrets expiring within 30 days'} className={cx('ml-1.5 inline-block h-1.5 w-1.5 rounded-full', w === 'red' ? 'bg-red-500' : 'bg-amber-400')} />
}

function selTitle(sel: Sel, tree: ProjectNode[]): string[] {
  if (sel.kind === 'all') return ['All secrets']
  if (sel.kind === 'expiring') return ['Expiring soon']
  if (sel.kind === 'recent') return ['Recently changed']
  const p = tree.find((x) => x.key === sel.project)
  if (sel.kind === 'project') return [p?.name ?? sel.project]
  return [p?.name ?? sel.project, p?.services.get(sel.service)?.name ?? 'Project-level']
}

function TreeButton({ active, depth = 0, count, onClick, children, open, onToggle }: { active: boolean; depth?: number; count?: number; onClick: () => void; children: React.ReactNode; open?: boolean; onToggle?: () => void }) {
  return (
    <div
      className={cx('flex items-center gap-1 rounded-md pr-2 text-sm', active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200')}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <button type="button" onClick={onToggle} className={cx('flex w-4 justify-center text-zinc-500 hover:text-zinc-200', !onToggle && 'invisible')} aria-label={open ? 'Collapse' : 'Expand'}>
        <Icon name="chevron" className={cx('h-3 w-3 transition-transform', open && 'rotate-90')} />
      </button>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5 text-left">
        <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
        {count != null && <span className="text-xs text-zinc-500">{count}</span>}
      </button>
    </div>
  )
}

/** Edit dialog wrapper for a secret listed on the global page (needs that project's services). */
function EditSecret({ secret, onClose, onSaved }: { secret: Secret; onClose: () => void; onSaved: () => void }) {
  const { services } = useServices(secret.project_key)
  if (!services) return null
  return <SecretForm environmentId={secret.environment_id} services={services} defaultService="" existing={secret} onClose={onClose} onSaved={onSaved} />
}

/** A secret card on the global page; loads its project's services for the Move dialog. */
function VaultSecret({ secret, showProject, onEdit, onChanged }: { secret: Secret; showProject: boolean; onEdit: () => void; onChanged: () => void }) {
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const { services } = useServices(secret.project_key)
  return <SecretRow secret={secret} services={services ?? []} showService showProject={showProject} writable={writable} onEdit={onEdit} onChanged={onChanged} />
}

/** "+ Add secret here": opens the regular form pre-filled with the folder's service and the selected environment. */
function AddSecretHere({ projectKey, defaultService, defaultEnv, onClose, onSaved }: { projectKey: string; defaultService: string; defaultEnv: string; onClose: () => void; onSaved: () => void }) {
  const { services } = useServices(projectKey)
  const [envs, setEnvs] = useState<Environment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<{ environments: Environment[] }>(`/api/projects/${encodeURIComponent(projectKey)}/environments`)
      .then((r) => setEnvs(r.environments))
      .catch((e) => setError(e.message))
  }, [projectKey])

  if (envs && envs.length > 0 && services) {
    const pre = envs.find((e) => e.name === defaultEnv) ?? envs[0]
    return <SecretForm environmentId={pre.id} environments={envs} projectKey={projectKey} services={services} defaultService={defaultService} onClose={onClose} onSaved={onSaved} />
  }
  return (
    <Modal title="Add secret" onClose={onClose}>
      <ErrorBox error={error} />
      {!envs ? <Spinner /> : <p className="text-sm text-zinc-400">This project has no environments yet. Add one from the project page first.</p>}
    </Modal>
  )
}

/** "Add multiple" from the global Vault page: loads the project's environments and services, then opens the paste dialog. */
function BulkAddHere({ projectKey, defaultService, defaultEnv, onClose, onDone }: { projectKey: string; defaultService: string; defaultEnv: string; onClose: () => void; onDone: () => void }) {
  const { services } = useServices(projectKey)
  const [envs, setEnvs] = useState<Environment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<{ environments: Environment[] }>(`/api/projects/${encodeURIComponent(projectKey)}/environments`)
      .then((r) => setEnvs(r.environments))
      .catch((e) => setError(e.message))
  }, [projectKey])

  if (envs && envs.length > 0 && services) {
    const pre = envs.find((e) => e.name === defaultEnv) ?? envs[0]
    return <BulkAddModal environments={envs} initialEnvId={pre.id} services={services} defaultService={defaultService} onClose={onClose} onDone={onDone} />
  }
  return (
    <Modal title="Add multiple secrets" onClose={onClose}>
      <ErrorBox error={error} />
      {!envs ? <Spinner /> : <p className="text-sm text-zinc-400">This project has no environments yet. Add one from the project page first.</p>}
    </Modal>
  )
}

/** ⌘K / Ctrl+K palette: jump straight to any secret. */
function QuickFind({ secrets, onPick, onClose }: { secrets: Secret[]; onPick: (s: Secret) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    const hit = (s: Secret) => !t || [s.name, s.project_name, s.service_key ?? '', s.environment, ...s.tags].some((x) => x.toLowerCase().includes(t))
    return secrets.filter(hit).slice(0, 12)
  }, [q, secrets])
  useEffect(() => setIdx(0), [q])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[idx]) {
      e.preventDefault()
      onPick(results[idx])
    }
  }
  return (
    <Modal title="Quick find" onClose={onClose}>
      <div onKeyDown={onKey}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a secret…" autoFocus />
        <ul className="mt-3 max-h-80 overflow-auto rounded-md border border-zinc-800 divide-y divide-zinc-800/70">
          {results.length === 0 && <li className="px-3 py-3 text-sm text-zinc-500">No matches</li>}
          {results.map((s, i) => (
            <li key={s.id}>
              <button onClick={() => onPick(s)} onMouseEnter={() => setIdx(i)} className={cx('flex w-full items-center justify-between gap-3 px-3 py-2 text-left', i === idx ? 'bg-zinc-800' : '')}>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-zinc-100 mono">{s.name}</span>
                  <span className="text-xs text-zinc-500">{s.project_name}{s.service_key ? ` / ${s.service_key}` : ''}</span>
                </span>
                <Badge>{s.environment}</Badge>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-xs text-zinc-500">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </Modal>
  )
}

export function VaultPage() {
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [expiring, setExpiring] = useState('')
  const [secrets, setSecrets] = useState<Secret[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Sel>({ kind: 'all' })
  const [env, setEnv] = useState('')
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [finding, setFinding] = useState(false)
  const [adding, setAdding] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [editing, setEditing] = useState<Secret | null>(null)
  const { user } = useAuth()
  const writable = !!user && canWrite(user.role)
  const admin = !!user && isAdmin(user.role)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setFinding(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

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
  }, [q, tag, expiring, reloadKey])

  const all = secrets ?? []
  const tree = useMemo(() => buildTree(all), [all])
  const allTags = [...new Set(all.flatMap((s) => s.tags))].sort()
  const searching = q.trim() !== '' || tag.trim() !== '' || expiring !== ''

  const scoped = all.filter((s) => matches(sel, s))
  const envs = [...new Set(scoped.map((s) => s.environment))].sort()
  const activeEnv = envs.includes(env) ? env : ''
  let list = scoped.filter((s) => !activeEnv || s.environment === activeEnv)
  list = [...list].sort(
    sel.kind === 'recent'
      ? (a, b) => b.updated_at.localeCompare(a.updated_at)
      : (a, b) => a.name.localeCompare(b.name) || a.environment.localeCompare(b.environment),
  )
  if (sel.kind === 'recent') list = list.slice(0, 25)

  const expSoon = all.filter((s) => s.days_left != null && s.days_left <= 30).length
  const expired = all.filter((s) => s.days_left != null && s.days_left < 0).length

  const toggle = (k: string) =>
    setOpenProjects((cur) => {
      const n = new Set(cur)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const choose = (s: Sel) => {
    setSel(s)
    setSelectedId(null)
  }
  const isOpen = (k: string) => searching || openProjects.has(k) || (sel.kind !== 'all' && 'project' in sel && sel.project === k)
  const crumbs = selTitle(sel, tree)
  const pick = (s: Secret) => {
    setFinding(false)
    setEnv('')
    setSel({ kind: 'service', project: s.project_key, service: s.service_key ?? PROJECT_LEVEL })
    setOpenProjects((c) => new Set(c).add(s.project_key))
    setSelectedId(s.id)
  }
  const folderProject = sel.kind === 'project' || sel.kind === 'service' ? sel.project : null
  const folderServiceId = sel.kind === 'service' ? (tree.find((p) => p.key === sel.project)?.services.get(sel.service)?.id ?? '') : ''
  // Delete all acts on this folder: the whole project, one service, or the project-level secrets.
  // (If a service folder's ID can't be found we offer nothing — an empty scope would mean "everything".)
  const deleteScope = sel.kind === 'service' ? (sel.service === PROJECT_LEVEL ? '-' : folderServiceId) : ''
  const canDeleteAll = admin && !!folderProject && scoped.length > 0 && (sel.kind !== 'service' || sel.service === PROJECT_LEVEL || folderServiceId !== '')
  const deleteChoices = [...new Map(scoped.map((s) => [s.environment_id, s.environment])).entries()].map(([id, name]) => ({ id, name, count: scoped.filter((s) => s.environment_id === id).length }))
  const copyEnv = deleteChoices.find((choice) => choice.name === (activeEnv || (envs.length === 1 ? envs[0] : '')))
  const deleteLabel = sel.kind === 'project' ? 'the whole project, every service' : sel.kind === 'service' ? (sel.service === PROJECT_LEVEL ? 'the project itself' : `service ${sel.service}`) : ''

  return (
    <>
      <PageHeader title="Vault"
        actions={<Button variant="secondary" onClick={() => setFinding(true)}>Quick find <span className="ml-1 text-xs text-zinc-500">⌘K</span></Button>}
      />

      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        {[
          ['Secrets', all.length, 'text-zinc-100'],
          ['Expiring in 30d', expSoon - expired, expSoon - expired > 0 ? 'text-amber-300' : 'text-zinc-100'],
          ['Expired', expired, expired > 0 ? 'text-red-400' : 'text-zinc-100'],
        ].map(([label, n, cls]) => (
          <Card key={label as string} className="px-4 py-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className={cx('text-xl font-semibold', cls as string)}>{n}</div>
          </Card>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, project or service…" />
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
      ) : all.length === 0 ? (
        <Empty title="No secrets found">{searching ? 'Try a different search.' : 'Add secrets from a project page.'}</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
          {/* folder tree */}
          <Card className="h-fit p-2">
            <TreeButton active={sel.kind === 'all'} count={all.length} onClick={() => choose({ kind: 'all' })}><Icon name="layers" className="text-zinc-500" />All secrets</TreeButton>
            <div className="mt-1 space-y-0.5">
              {tree.map((p) => {
                const open = isOpen(p.key)
                const svcs = [...p.services.entries()].sort(([a], [b]) => a.localeCompare(b))
                return (
                  <div key={p.key}>
                    <TreeButton
                      active={sel.kind === 'project' && sel.project === p.key}
                      count={p.secrets.length}
                      open={open}
                      onToggle={() => toggle(p.key)}
                      onClick={() => {
                        choose({ kind: 'project', project: p.key })
                        setOpenProjects((c) => new Set(c).add(p.key))
                      }}
                    >
                      <Icon name="folder" className="text-zinc-500" />{p.name}<ExpiryDot list={p.secrets} />
                    </TreeButton>
                    {open &&
                      svcs.map(([sk, sv]) => (
                        <TreeButton
                          key={sk}
                          depth={1}
                          active={sel.kind === 'service' && sel.project === p.key && sel.service === sk}
                          count={sv.secrets.length}
                          onClick={() => choose({ kind: 'service', project: p.key, service: sk })}
                        >
                          {sk === PROJECT_LEVEL ? <span className="italic">project-level</span> : <><Icon name="box" className="text-zinc-500" />{sv.name}</>}<ExpiryDot list={sv.secrets} />
                        </TreeButton>
                      ))}
                  </div>
                )
              })}
            </div>
            <div className="my-2 border-t border-zinc-800" />
            <TreeButton active={sel.kind === 'expiring'} count={expSoon} onClick={() => choose({ kind: 'expiring' })}><Icon name="alert" className="text-amber-400" />Expiring soon</TreeButton>
            <TreeButton active={sel.kind === 'recent'} onClick={() => choose({ kind: 'recent' })}><Icon name="clock" className="text-zinc-500" />Recently changed</TreeButton>
          </Card>

          {/* list + detail */}
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-sm font-medium text-zinc-200">
                {crumbs.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <span className="px-1.5 text-zinc-600">/</span>}
                    {c}
                  </span>
                ))}
                <span className="ml-2 text-xs font-normal text-zinc-500">{list.length} secret{list.length === 1 ? '' : 's'}</span>
              </h2>
              {writable && folderProject && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {copyEnv && (sel.kind !== 'service' || deleteScope) && (
                    <CopyAllSecrets key={`${copyEnv.id}:${deleteScope}`} envId={copyEnv.id} name={copyEnv.name} scope={deleteScope} />
                  )}
                  {canDeleteAll && <Button variant="ghost" className="py-1 text-xs text-red-400 hover:!text-red-300" onClick={() => setDeletingAll(true)}>Delete all</Button>}
                  <Button variant="secondary" className="py-1 text-xs" onClick={() => setBulk(true)}>Add multiple</Button>
                  <Button variant="secondary" className="py-1 text-xs" onClick={() => setAdding(true)}>+ Add secret here</Button>
                </div>
              )}
              {envs.length > 1 && (
                <div className="flex flex-wrap gap-1.5 basis-full">
                  {['', ...envs].map((e) => (
                    <button
                      key={e || 'all'}
                      onClick={() => setEnv(e)}
                      className={cx(
                        'rounded-md border px-2.5 py-1 text-xs',
                        e === activeEnv ? 'border-emerald-600 bg-emerald-950/40 text-emerald-200' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200',
                      )}
                    >
                      {e || 'all envs'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {list.length === 0 ? (
              <Empty title="Nothing here">No secrets match this folder.{writable && folderProject ? ' Use “+ Add secret here” to create one.' : ''}</Empty>
            ) : (
              <div className="space-y-2">
                {list.map((s) => (
                  <div key={s.id} className={cx('rounded-lg', s.id === selectedId && 'ring-1 ring-emerald-600/60')}>
                    <VaultSecret secret={s} showProject={sel.kind !== 'service'} onEdit={() => setEditing(s)} onChanged={() => setReloadKey((k) => k + 1)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {editing && (
        <EditSecret
          secret={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
      {finding && <QuickFind secrets={all} onPick={pick} onClose={() => setFinding(false)} />}
      {bulk && folderProject && (
        <BulkAddHere
          projectKey={folderProject}
          defaultService={folderServiceId}
          defaultEnv={activeEnv}
          onClose={() => setBulk(false)}
          onDone={() => {
            setBulk(false)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
      {deletingAll && canDeleteAll && (
        <DeleteAllModal
          choices={deleteChoices}
          initialEnvId={deleteChoices.find((c) => c.name === activeEnv)?.id ?? ''}
          scope={deleteScope}
          scopeLabel={deleteLabel}
          onClose={() => setDeletingAll(false)}
          onDone={() => {
            setDeletingAll(false)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
      {adding && folderProject && (
        <AddSecretHere
          projectKey={folderProject}
          defaultService={folderServiceId}
          defaultEnv={activeEnv}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
    </>
  )
}
