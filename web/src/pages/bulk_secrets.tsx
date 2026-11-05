import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Secret, type Service } from '../api'
import { parseDotenv } from '../dotenv'
import { Badge, Button, ErrorBox, Field, Input, Modal, Select, Textarea, cx } from '../ui'

/** A styled "are you sure?" — one click confirms, nothing to type. */
export function ConfirmModal({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string
  children: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-zinc-300">{children}</div>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button variant={danger ? 'danger' : 'primary'} onClick={go} disabled={busy} autoFocus>{busy ? 'Working…' : confirmLabel}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

/** "Delete all": the red button stays off until the environment's name is typed. */
export function DeleteAllModal({
  choices,
  initialEnvId,
  scope,
  scopeLabel,
  onClose,
  onDone,
}: {
  choices: { id: string; name: string; count: number }[] // environments that have secrets here; one = no picker
  initialEnvId: string
  scope: string // '' = every secret in the environment, '-' = the project's own, or a service ID
  scopeLabel: string
  onClose: () => void
  onDone: () => void
}) {
  const [pickedId, setPickedId] = useState(choices.some((c) => c.id === initialEnvId) ? initialEnvId : (choices[0]?.id ?? ''))
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = choices.find((c) => c.id === pickedId) ?? choices[0]
  const envId = chosen?.id ?? ''
  const envName = chosen?.name ?? ''
  const count = chosen?.count ?? 0
  const ok = envName !== '' && typed === envName

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/environments/${envId}/secrets/delete-all`, { method: 'POST', body: { service: scope, confirm: typed } })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Delete all secrets" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) submit()
        }}
      >
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          This permanently deletes <b>{count} secret{count === 1 ? '' : 's'}</b> in <b>{envName}</b> ({scopeLabel}), with every earlier version. It can’t be undone.
        </div>
        {choices.length > 1 && (
          <Field label="Environment">
            <Select value={pickedId} onChange={(e) => { setPickedId(e.target.value); setTyped('') }}>
              {choices.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count} secret{c.count === 1 ? '' : 's'})</option>)}
            </Select>
          </Field>
        )}
        <Field label={<>Type <span className="mono text-zinc-100">{envName}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" variant="danger" disabled={!ok || busy}>{busy ? 'Deleting…' : `Delete ${count} secret${count === 1 ? '' : 's'}`}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

const PLACEHOLDER = `# Paste your .env here — one NAME=value per line
DATABASE_URL=postgres://user:pass@host:5432/db
STRIPE_KEY="sk_live_..."
export SENTRY_DSN='https://...'`

/** Add many secrets at once by pasting (or loading) a .env file. */
export function BulkAddModal({
  environments,
  initialEnvId,
  services,
  defaultService,
  onClose,
  onDone,
}: {
  environments: { id: string; name: string }[] // one = no picker
  initialEnvId: string
  services: Service[]
  defaultService: string // '' = the project directly, or a service ID
  onClose: () => void
  onDone: () => void
}) {
  const [envId, setEnvId] = useState(environments.some((e) => e.id === initialEnvId) ? initialEnvId : (environments[0]?.id ?? ''))
  const envName = environments.find((e) => e.id === envId)?.name ?? ''
  const [text, setText] = useState('')
  const [service, setService] = useState(defaultService)
  const [overwrite, setOverwrite] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [existing, setExisting] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  // Which names already exist where these will go (the chosen service, or the project itself).
  useEffect(() => {
    setExisting(null)
    api<{ secrets: Secret[] }>(`/api/secrets?environment=${envId}&service=${service === '' ? '-' : service}`)
      .then((r) => setExisting(new Set(r.secrets.map((s) => s.name))))
      .catch(() => setExisting(new Set()))
  }, [envId, service])

  const rows = useMemo(() => parseDotenv(text), [text])
  const valid = rows.filter((r) => !r.error)
  const isNew = (n: string) => !(existing?.has(n) ?? false)
  const toSend = valid.filter((r) => isNew(r.name) || overwrite)
  const skipped = valid.length - toSend.length
  const invalid = rows.length - valid.length

  const load = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 512 * 1024) return setError('That file is too big for an .env file.')
    setError(null)
    setText(await f.text())
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/environments/${envId}/secrets/bulk`, {
        method: 'POST',
        body: { service_id: service, overwrite, secrets: toSend.map((r) => ({ name: r.name, value: r.value })) },
      })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Add multiple secrets to ${envName}`} onClose={onClose} wide>
      <div className="space-y-4">
        {environments.length > 1 && (
          <Field label="Environment">
            <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
              {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Paste a .env file" hint="One NAME=value per line. Comments, “export”, quotes and multi-line values work.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={PLACEHOLDER} spellCheck={false} autoFocus className="mono text-xs" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={file} type="file" accept=".env,text/plain,.txt,*/*" className="hidden" onChange={(e) => { load(e.target.files?.[0]); e.target.value = '' }} />
          <Button type="button" variant="secondary" onClick={() => file.current?.click()}>Load a file…</Button>
          {services.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span>Add to</span>
              <div className="w-56">
                <Select value={service} onChange={(e) => setService(e.target.value)}>
                  <option value="">The project itself</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.key})</option>)}
                </Select>
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="accent-emerald-500" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Overwrite ones that already exist
          </label>
        </div>

        {rows.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-500">
              <span>
                {valid.length} found{invalid > 0 && <span className="text-red-400"> · {invalid} can’t be added</span>}
                {skipped > 0 && <span className="text-amber-400"> · {skipped} already exist and will be skipped</span>}
              </span>
              <button type="button" className="text-zinc-400 hover:text-zinc-200" onClick={() => setReveal((v) => !v)}>{reveal ? 'Hide values' : 'Show values'}</button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border border-zinc-800">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-zinc-800/70">
                  {rows.map((r, i) => (
                    <tr key={i} className={cx(r.error && 'bg-red-950/20')}>
                      <td className="w-6 px-3 py-1.5 text-zinc-600">{r.line}</td>
                      <td className="mono whitespace-nowrap px-2 py-1.5 text-zinc-100">{r.name}</td>
                      <td className="mono max-w-[16rem] truncate px-2 py-1.5 text-zinc-400">
                        {r.error ? '' : reveal ? r.value.replace(/\n/g, '⏎') : '•'.repeat(Math.min(r.value.length, 12))}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {r.error ? (
                          <span className="text-red-400">{r.error}</span>
                        ) : isNew(r.name) ? (
                          <Badge tone="green">new</Badge>
                        ) : overwrite ? (
                          <Badge tone="amber">overwrite</Badge>
                        ) : (
                          <Badge>exists — skipped</Badge>
                        )}
                        {r.note && <div className="text-[10px] text-zinc-500">{r.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button onClick={submit} disabled={busy || toSend.length === 0 || existing === null}>
            {busy ? 'Adding…' : toSend.length === 0 ? 'Add secrets' : `Add ${toSend.length} secret${toSend.length === 1 ? '' : 's'}`}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}
