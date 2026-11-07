import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { Button, Card, ErrorBox, Modal, Select, Spinner } from '../ui'
import { fmtSize } from './backups'
import { SystemJobs } from './system_jobs'

interface Policy {
  job_run_days: number
  health_result_days: number
  health_event_days: number
  alert_log_days: number
  audit_days: number
  secret_versions_keep: number
  confirmed: boolean
}

interface Category {
  key: string
  label: string
  rule: string
  gated: boolean
  eligible: number
  /** false = automatic cleanup skips it (kept forever, or not confirmed yet). */
  active: boolean
}

interface Overview {
  policy: Policy
  defaults: Policy
  categories: Category[]
  db_bytes: number
  tables: { table: string; bytes: number; rows: number }[]
}

interface Payload {
  overview: Overview
  editable: boolean
}

type Fields = Omit<Policy, 'confirmed'>

const FIELDS: {
  key: keyof Fields
  label: string
  hint: string
  choices: [number, string][]
}[] = [
  {
    key: 'job_run_days',
    label: 'Job run history',
    hint: 'Each job always keeps its last 20 runs, however old, so a monthly job never loses its history.',
    choices: [[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days']],
  },
  {
    key: 'health_result_days',
    label: 'Health check results',
    hint: 'One row per probe. This is most of the database for busy checks. The 30-day uptime and chart only cover what is kept.',
    choices: [[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days']],
  },
  {
    key: 'health_event_days',
    label: 'Health status changes',
    hint: 'The up / down history of each check. Very small.',
    choices: [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']],
  },
  {
    key: 'alert_log_days',
    label: 'Alert log',
    hint: 'Which alerts were sent. Expiry reminders are remembered until the expiry has passed, so they are never sent twice.',
    choices: [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']],
  },
  {
    key: 'audit_days',
    label: 'Audit log',
    hint: 'Who did what. Keep this as long as you may need it for an investigation.',
    choices: [[90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1095, '3 years'], [0, 'Forever']],
  },
  {
    key: 'secret_versions_keep',
    label: 'Old secret versions',
    hint: 'How many versions of each secret to keep for rollback. The current value is never removed, and old values stop sitting in the database.',
    choices: [[3, 'Last 3'], [5, 'Last 5'], [10, 'Last 10'], [20, 'Last 20'], [50, 'Last 50'], [0, 'All of them']],
  },
]

const NEVER: string[] = [
  'Users, roles and project access',
  'Projects, services and environments',
  'Secrets and their current value',
  'API and deploy tokens',
  'Job and health-check definitions',
  'Alert channels and settings',
]

const nice = (n: number) => n.toLocaleString()

function fieldsOf(p: Policy): Fields {
  return {
    job_run_days: p.job_run_days,
    health_result_days: p.health_result_days,
    health_event_days: p.health_event_days,
    alert_log_days: p.alert_log_days,
    audit_days: p.audit_days,
    secret_versions_keep: p.secret_versions_keep,
  }
}

function Block({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 px-1">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        <p className="text-xs text-zinc-400">{description}</p>
      </div>
      <Card className="divide-y divide-zinc-800">{children}</Card>
    </section>
  )
}

/** Settings → Data: how big the database is, how long each kind of history is kept and the weekly cleanup job. */
export function DataSettings() {
  const [data, setData] = useState<Payload | null>(null)
  const [draft, setDraft] = useState<Fields | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ categories: Category[] } | null>(null)

  const apply = useCallback((p: Payload) => {
    setData(p)
    setDraft(fieldsOf(p.overview.policy))
  }, [])

  useEffect(() => {
    api<Payload>('/api/retention').then(apply).catch((e) => setError(e.message))
  }, [apply])

  if (error && !data) return <ErrorBox error={error} persistent />
  if (!data || !draft) return <Spinner />

  const { overview: o, editable } = data
  const changed = (Object.keys(draft) as (keyof Fields)[]).some((k) => draft[k] !== o.policy[k])
  const maxBytes = Math.max(1, ...o.tables.map((t) => t.bytes))

  async function askSave() {
    if (!draft) return
    setError(null)
    setDone(null)
    setBusy(true)
    try {
      const r = await api<{ categories: Category[] }>('/api/retention/preview', { method: 'POST', body: draft })
      setConfirm({ categories: r.categories })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function doConfirm() {
    if (!confirm || !draft) return
    setBusy(true)
    setError(null)
    try {
      apply(await api<Payload>('/api/retention', { method: 'PUT', body: draft }))
      setDone('Saved. The cleanup runs once a week, or when you press Run now under Jobs.')
      setConfirm(null)
    } catch (e) {
      setError((e as Error).message)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {!o.policy.confirmed && (
        <div role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The audit log, old secret versions and health status changes are <strong>not being cleaned yet</strong>. Pick how long to keep
          them and save, and cleanup of those starts. Everything else is already cleaned with the values shown.
        </div>
      )}

      <Block title="Storage" description="How much room Rexus uses in its database. Rows are estimates.">
        <div className="flex items-center justify-between px-5 py-3 text-sm">
          <span className="text-zinc-300">Whole database</span>
          <span className="mono text-zinc-100">{fmtSize(o.db_bytes)}</span>
        </div>
        {o.tables.map((t) => (
          <div key={t.table} className="px-5 py-2.5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="mono text-zinc-300">{t.table}</span>
              <span className="text-xs text-zinc-400">
                ≈ {nice(t.rows)} rows · <span className="mono text-zinc-200">{fmtSize(t.bytes)}</span>
              </span>
            </div>
            <div className="mt-1.5 h-1 rounded bg-zinc-800" aria-hidden>
              <div className="h-1 rounded bg-emerald-500/70" style={{ width: `${Math.max(2, (t.bytes / maxBytes) * 100)}%` }} />
            </div>
          </div>
        ))}
      </Block>

      <Block
        title="How long to keep history"
        description={editable ? 'Older rows are deleted automatically, once a week.' : 'Only the owner can change these.'}
      >
        {FIELDS.map((f) => {
          const cat = o.categories.find((c) => c.label === f.label)
          const choices = f.choices.some(([v]) => v === draft[f.key]) ? f.choices : [...f.choices, [draft[f.key], String(draft[f.key])] as [number, string]]
          return (
            <div key={f.key} className="grid gap-x-8 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] md:items-center">
              <div className="min-w-0">
                <label htmlFor={`ret-${f.key}`} className="text-sm font-medium text-zinc-200">{f.label}</label>
                <div className="mt-0.5 text-xs text-zinc-400">{f.hint}</div>
                {cat && cat.eligible > 0 && (
                  <div className="mt-1 text-xs text-zinc-500">{nice(cat.eligible)} rows are past this now{cat.active ? '' : ' (not deleted until you save)'}.</div>
                )}
              </div>
              <Select
                id={`ret-${f.key}`}
                value={draft[f.key]}
                disabled={!editable || busy}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              >
                {choices.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </Select>
            </div>
          )
        })}
        <div className="px-5 py-3 text-xs text-zinc-500">
          Also cleaned automatically: used or expired invites and reset links (after 30 days) and expired sign-ins (after 7 days).
        </div>
      </Block>

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={askSave} disabled={busy || (!changed && o.policy.confirmed)}>
            {o.policy.confirmed ? 'Save' : 'Save and start cleaning'}
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setDraft(fieldsOf(o.policy))} disabled={busy}>Undo changes</Button>
          )}
          {done && <span role="status" className="text-sm text-emerald-400">{done}</span>}
        </div>
      )}
      <ErrorBox error={error} />

      <SystemJobs />

      <Block title="Never cleaned" description="These are not history, so no setting here ever removes them.">
        <ul className="grid gap-x-6 gap-y-1 px-5 py-3 text-sm text-zinc-300 sm:grid-cols-2">
          {NEVER.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Block>

      {confirm && (
        <Modal title="Save and delete old history?" onClose={() => !busy && setConfirm(null)}>
          <div className="space-y-3 text-sm text-zinc-300">
            {(() => {
              const rows = confirm.categories.filter((c) => c.eligible > 0 && true)
              return rows.length === 0 ? (
                <p>Nothing is past its time right now, so nothing will be deleted.</p>
              ) : (
                <>
                  <p>This permanently deletes:</p>
                  <ul className="space-y-1">
                    {rows.map((c) => (
                      <li key={c.key} className="flex justify-between gap-4">
                        <span>{c.label}</span>
                        <span className="mono text-zinc-100">{nice(c.eligible)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-zinc-400">There is no undo. Download a backup first if you may need any of it.</p>
                </>
              )
            })()}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
              <Button variant="danger" onClick={doConfirm} disabled={busy}>Save and delete</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
