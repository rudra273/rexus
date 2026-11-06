import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type BackupRow, type BackupStatus } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Spinner, cx, fmtTime, timeAgo } from '../ui'

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

/**
 * Makes a backup on the server and saves it to this computer through the browser. Nothing is kept on the
 * server. Throws an Error with a readable message when the server refuses or the backup fails.
 */
export async function downloadBackup(): Promise<{ name: string; size: number }> {
  const res = await fetch('/api/backups/download', { method: 'POST', headers: { 'X-Rexus-Request': '1' }, credentials: 'same-origin' })
  if (!res.ok) {
    let msg = `Backup failed (${res.status})`
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, msg)
  }
  const blob = await res.blob()
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'rexus-backup.dump'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { name, size: blob.size }
}

type Tone = 'green' | 'amber' | 'red' | 'blue'

/** What the always-visible indicator says. */
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

/** The "Backup now" button: makes the backup and saves it here. Used on the Backups page and in Settings. */
export function BackupNowButton({ running, onDone, onError }: { running?: boolean; onDone: (r: { name: string; size: number }) => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    onError('')
    try {
      onDone(await downloadBackup())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
      window.dispatchEvent(new Event('rexus:backup'))
    }
  }
  return (
    <Button onClick={() => void go()} disabled={busy || running}>
      {busy || running ? 'Backing up…' : 'Backup now'}
    </Button>
  )
}

interface Resp {
  status: BackupStatus
  backups: BackupRow[]
}

export function BackupsPage() {
  const [data, setData] = useState<Resp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ name: string; size: number } | null>(null)

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
    const t = setInterval(load, running ? 2_000 : 30_000)
    window.addEventListener('rexus:backup', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('rexus:backup', load)
    }
  }, [load, running])

  if (error && !data) return <ErrorBox error={error} persistent />
  if (!data) return <Spinner />
  const { status, backups } = data
  const label = backupLabel(status)

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
        actions={<BackupNowButton running={running} onDone={(r) => { setDone(r); load() }} onError={(m) => setError(m || null)} />}
      />
      <ErrorBox error={error} />
      {done && <p role="status" className="mt-2 text-sm text-emerald-400">Saved {done.name} ({fmtSize(done.size)}) to your downloads.</p>}

      {(status.running || status.state !== 'ok') && (
        <div className={cx('mb-6 mt-2 rounded-md border px-4 py-3 text-sm', banner)}>
          <div className="flex items-center gap-2 font-medium">
            <span className={cx('inline-block h-2.5 w-2.5 rounded-full', DOT[label.tone])} />
            {status.running
              ? 'A backup is running…'
              : status.state === 'none'
                ? 'No backup has been made yet.'
                : status.state === 'failed'
                  ? 'The last backup failed.'
                  : 'It has been more than a week since the last backup.'}
          </div>
          {status.state === 'failed' && status.last_error && <div className="mt-2 break-words text-xs">{status.last_error}</div>}
        </div>
      )}

      <section>
        <h2 className="mb-3 font-medium text-zinc-200">Recent backups</h2>
        {backups.length === 0 ? (
          <Empty title="No backups yet">Click “Backup now” to save one.</Empty>
        ) : (
          <Card className="divide-y divide-zinc-800/70">
            {backups.map((b) => (
              <div key={b.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {b.status === 'success' ? <Badge tone="green">ok</Badge> : <Badge tone="red">failed</Badge>}
                    <span className="text-zinc-300" title={fmtTime(b.started_at)}>{timeAgo(b.started_at)}</span>
                    <span className="text-xs text-zinc-500">by {b.triggered_by || 'the command line'}</span>
                  </div>
                  {b.file_name && <div className="mono mt-1 break-all text-xs text-zinc-400">{b.file_name}</div>}
                  {b.error && <div className="mt-1 max-w-xl break-words text-xs text-red-300">{b.error}</div>}
                </div>
                <span className="text-xs text-zinc-400">{fmtSize(b.size_bytes)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mt-8">
        <details className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
          <summary className="cursor-pointer font-medium text-zinc-200">How to restore a backup</summary>
          <div className="mt-3 space-y-3 text-zinc-400">
            <p>A restore only works into an <b className="text-zinc-200">empty</b> database — it can never overwrite a live one. On the server, with the downloaded file:</p>
            <pre className="overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300 mono">rexus restore --file rexus-20261105-120000.dump</pre>
            <p>
              With Docker Compose, copy the file in first (add <code>-f docker-compose.external-db.yml</code> if that is the file you use):
              <code className="mt-1 block break-all">docker compose cp rexus-20261105-120000.dump rexus:/tmp/</code>
              <code className="mt-1 block break-all">docker compose exec rexus rexus restore --file /tmp/rexus-20261105-120000.dump</code>
            </p>
            <p>Use the same <code>REXUS_MASTER_KEY</code> as the instance that made the backup, or the vault secrets can’t be read.</p>
          </div>
        </details>
      </section>
    </>
  )
}
