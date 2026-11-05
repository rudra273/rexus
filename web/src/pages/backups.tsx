import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, type BackupFile, type BackupRow, type BackupSettings, type BackupStatus } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, cx, fmtTime, timeAgo } from '../ui'

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

const INTERVAL_LABEL: Record<number, string> = {
  0: 'Manual only (no schedule)',
  15: 'Every 15 minutes',
  60: 'Every hour',
  360: 'Every 6 hours',
  1440: 'Every 24 hours',
}

type Tone = 'green' | 'amber' | 'red' | 'blue'

/** What the always-visible indicator says (plan.md §9.4). */
export function backupLabel(s: BackupStatus): { text: string; tone: Tone } {
  if (s.running) return { text: 'Backing up…', tone: 'blue' }
  switch (s.state) {
    case 'none':
      return { text: 'No backup yet', tone: 'red' }
    case 'failed':
      return { text: 'Last backup failed', tone: 'red' }
    case 'stale':
      return { text: `Last backup: ${timeAgo(s.last_success_at)}`, tone: 'amber' }
    default:
      return { text: `Last backup: ${timeAgo(s.last_success_at)}`, tone: 'green' }
  }
}

const DOT: Record<Tone, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
  blue: 'bg-sky-400 animate-pulse',
}

/** Polls the backup status (owner/admin, when backups are on) and refreshes on demand. */
export function useBackupStatus(active: boolean) {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const refresh = useCallback(() => {
    api<BackupStatus>('/api/backups/status').then(setStatus).catch(() => {})
  }, [])
  useEffect(() => {
    if (!active) return
    refresh()
    const t = setInterval(refresh, 60_000)
    window.addEventListener('rexus:backup', refresh)
    return () => {
      clearInterval(t)
      window.removeEventListener('rexus:backup', refresh)
    }
  }, [active, refresh])
  return status
}

export function BackupPill({ status }: { status: BackupStatus | null }) {
  if (!status || !status.enabled) return null
  const { text, tone } = backupLabel(status)
  return (
    <Link
      to="/backups"
      title={status.last_success_at ? `Last good backup: ${fmtTime(status.last_success_at)}` : 'Open the backups page'}
      className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
    >
      <span className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', DOT[tone])} />
      {text}
    </Link>
  )
}

interface Resp {
  status: BackupStatus
  backups: BackupRow[]
  intervals: number[]
  dir_problem: string
}

export function BackupsPage() {
  const [data, setData] = useState<Resp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(() => {
    api<Resp>('/api/backups')
      .then((r) => {
        setData(r)
        setError(null)
      })
      .catch((e) => setError(e.message))
  }, [])

  const running = data?.status.running ?? false
  useEffect(() => {
    load()
    const t = setInterval(load, running ? 2_000 : 15_000)
    return () => clearInterval(t)
  }, [load, running])

  if (error && !data) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const { status, backups, intervals, dir_problem } = data
  const label = backupLabel(status)

  const backupNow = async () => {
    setStarting(true)
    setError(null)
    try {
      await api('/api/backups/run', { method: 'POST' })
      load()
      window.dispatchEvent(new Event('rexus:backup'))
      // Keep polling quickly until it finishes.
      setTimeout(() => window.dispatchEvent(new Event('rexus:backup')), 3000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const banner =
    label.tone === 'red'
      ? 'border-red-900 bg-red-950/40 text-red-200'
      : label.tone === 'amber'
        ? 'border-amber-900 bg-amber-950/40 text-amber-200'
        : label.tone === 'blue'
          ? 'border-sky-900 bg-sky-950/40 text-sky-200'
          : 'border-emerald-900 bg-emerald-950/30 text-emerald-200'

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle="A copy of the whole database, saved to a folder you control."
        actions={<Button onClick={backupNow} disabled={starting || running}>{running ? 'Backing up…' : 'Backup now'}</Button>}
      />
      <ErrorBox error={error} />

      <div className={cx('mb-6 mt-2 rounded-md border px-4 py-3 text-sm', banner)}>
        <div className="flex items-center gap-2 font-medium">
          <span className={cx('inline-block h-2.5 w-2.5 rounded-full', DOT[label.tone])} />
          {status.running
            ? 'A backup is running…'
            : status.state === 'none'
              ? 'No backup has run yet — click “Backup now”.'
              : status.state === 'failed'
                ? 'The last backup failed.'
                : status.state === 'stale'
                  ? 'Backups are overdue.'
                  : 'Backups are up to date.'}
        </div>
        <div className="mt-1 text-xs opacity-80">
          {status.last_success_at ? <>Last good backup {timeAgo(status.last_success_at)} ({fmtTime(status.last_success_at)}). </> : null}
          {status.settings.interval_minutes > 0 && status.next_run_at ? <>Next one {timeAgo(status.next_run_at)}. </> : null}
          {status.settings.interval_minutes === 0 ? 'Automatic backups are off.' : null}
        </div>
        {status.state === 'failed' && status.last_error && <div className="mt-2 break-words text-xs">{status.last_error}</div>}
      </div>

      {dir_problem && (
        <div className="mb-6 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <b>The backup folder isn’t usable.</b> {dir_problem}. Is the drive plugged in?
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 font-medium text-zinc-200">Settings</h2>
          <SettingsForm settings={status.settings} intervals={intervals} onSaved={() => { load(); window.dispatchEvent(new Event('rexus:backup')) }} />
        </section>
        <section>
          <h2 className="mb-3 font-medium text-zinc-200">Where they go</h2>
          <Card className="space-y-2 p-4 text-sm">
            <div className="text-zinc-400">Backup folder <span className="ml-2 text-zinc-200 mono">{status.dir}</span></div>
            <div className="text-zinc-400">Files in it <span className="ml-2 text-zinc-200">{status.files}</span></div>
            <p className="pt-1 text-xs text-zinc-500">
              Backups are plain copies, not encrypted — keep the folder on storage you trust (a local disk, an external drive, a pendrive). Vault
              secrets inside them stay encrypted and need <code>REXUS_MASTER_KEY</code> to be read. Files are named by date and time, so they sort in order.
            </p>
          </Card>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 font-medium text-zinc-200">History</h2>
        {backups.length === 0 ? (
          <Empty title="No backups yet">The first one is taken a few seconds after backups are switched on, or when you click “Backup now”.</Empty>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                  <th className="px-4 py-2.5 font-medium">Size</th>
                  <th className="px-4 py-2.5 font-medium">How</th>
                  <th className="px-4 py-2.5 font-medium">File</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {backups.map((b) => (
                  <tr key={b.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400" title={fmtTime(b.started_at)}>{timeAgo(b.started_at)}</td>
                    <td className="px-4 py-2.5">
                      {b.status === 'success' ? <Badge tone="green">ok</Badge> : <Badge tone="red">failed</Badge>}
                      {b.error && <div className="mt-1 max-w-xs break-words text-xs text-red-300">{b.error}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400">{fmtSize(b.size_bytes)}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{b.trigger === 'manual' ? `by ${b.triggered_by ?? 'CLI'}` : 'scheduled'}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {b.file_name ? (
                        <>
                          <span className="text-zinc-300 mono">{b.file_name}</span>
                          {!b.on_disk && <div className="text-zinc-500">no longer in the folder</div>}
                        </>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section className="mt-8">
        <details className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
          <summary className="cursor-pointer font-medium text-zinc-200">How to restore a backup</summary>
          <div className="mt-3 space-y-3 text-zinc-400">
            <p>A restore only works into an <b className="text-zinc-200">empty</b> database — it can never overwrite a live one. For a new or wiped instance, either:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Open the setup screen: if it finds backups in the backup folder it offers to restore one, using the one-time setup code from the server logs; or</li>
              <li>
                Run on the server:
                <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300 mono">rexus restore --file /backups/rexus-20261105-120000.dump</pre>
                (with Docker: <code>docker compose exec rexus rexus restore --file /backups/…</code>)
              </li>
            </ul>
            <p>Use the same <code>REXUS_MASTER_KEY</code> as the instance that made the backup, or the vault secrets can’t be read.</p>
          </div>
        </details>
      </section>
    </>
  )
}

function SettingsForm({ settings, intervals, onSaved }: { settings: BackupSettings; intervals: number[]; onSaved: () => void }) {
  const [interval, setIntervalMin] = useState(settings.interval_minutes)
  const [keep, setKeep] = useState(settings.keep)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setIntervalMin(settings.interval_minutes)
    setKeep(settings.keep)
  }, [settings.interval_minutes, settings.keep])

  const dirty = interval !== settings.interval_minutes || keep !== settings.keep

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/backups/settings', { method: 'PUT', body: { interval_minutes: interval, keep } })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Back up automatically">
          <Select value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
            {intervals.map((m) => (
              <option key={m} value={m}>{INTERVAL_LABEL[m] ?? `Every ${m} minutes`}</option>
            ))}
          </Select>
        </Field>
        <Field label="Keep the last" hint="Older backups are deleted automatically, but never one that isn’t a Rexus backup file.">
          <div className="flex items-center gap-2">
            <div className="w-24"><Input type="number" min={1} max={500} value={keep} onChange={(e) => setKeep(Number(e.target.value))} /></div>
            <span className="text-sm text-zinc-400">backups</span>
          </div>
        </Field>
        <ErrorBox error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save settings'}</Button>
          {saved && <span className="text-sm text-emerald-400">Saved</span>}
        </div>
      </form>
    </Card>
  )
}

// ───────────────────────── restore on the setup screen ─────────────────────────

/** Shown on the first-time setup page when backups are found in the backup folder. */
export function RestoreFromBackup({ code }: { code: string }) {
  const [files, setFiles] = useState<BackupFile[] | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ warning?: string; empty?: boolean } | null>(null)

  useEffect(() => {
    api<{ enabled: boolean; files: BackupFile[] }>('/api/setup/backups')
      .then((r) => {
        setFiles(r.files)
        setPick(r.files[0]?.name ?? '')
      })
      .catch(() => setFiles([]))
  }, [])

  if (!files || files.length === 0) return null

  const restore = async () => {
    setError(null)
    if (!code.trim()) return setError('Enter the setup code above first — it’s printed in the Rexus server logs.')
    if (!confirm(`Restore ${pick}? This brings back its users, projects, jobs and secrets, and you will log in with the accounts from the backup.`)) return
    setBusy(true)
    try {
      const r = await api<{ ok: boolean; owner_exists: boolean; warning?: string }>('/api/setup/restore', { method: 'POST', body: { code, file: pick } })
      setDone({ warning: r.warning, empty: !r.owner_exists })
      if (!r.warning && r.owner_exists) setTimeout(() => window.location.assign('/'), 1500)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-8 border-t border-zinc-800 pt-6">
      <h2 className="font-medium text-zinc-100">Or restore from a backup</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Found {files.length} backup{files.length === 1 ? '' : 's'} in your backup folder. You need the same <code>REXUS_MASTER_KEY</code> as the
        instance that made it.
      </p>
      {done?.empty ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            That backup has no accounts in it — it was taken from an empty database. Nothing was lost; choose an older backup, or create the owner above.
          </div>
          <Button variant="secondary" className="w-full" onClick={() => setDone(null)}>Choose another backup</Button>
        </div>
      ) : done ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">Restored. Log in with an account from the backup.</div>
          {done.warning && <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">{done.warning}</div>}
          <Button className="w-full" onClick={() => window.location.assign('/')}>Continue to login</Button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Backup to restore">
            {files.map((f) => (
              <option key={f.name} value={f.name}>{new Date(f.created_at).toLocaleString()} · {fmtSize(f.size_bytes)}</option>
            ))}
          </Select>
          <ErrorBox error={error} />
          <Button variant="secondary" className="w-full" onClick={restore} disabled={busy}>{busy ? 'Restoring… this can take a minute' : 'Restore this backup'}</Button>
        </div>
      )}
    </div>
  )
}
