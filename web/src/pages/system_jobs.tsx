import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Badge, Button, Card, ErrorBox, Modal, StatusDot, fmtTime, timeAgo } from '../ui'

interface Run {
  id: number
  trigger: 'schedule' | 'manual'
  status: 'running' | 'success' | 'failed'
  triggered_by: string | null
  started_at: string
  duration_ms: number | null
  result: { deleted?: Record<string, number> }
  error: string | null
}

interface SystemJob {
  key: string
  name: string
  description: string
  schedule: string
  enabled: boolean
  next_run_at: string | null
  last_run: Run | null
}

const LABELS: Record<string, string> = {
  job_runs: 'job runs',
  health_results: 'health results',
  health_events: 'health status changes',
  alerts_sent: 'alert log entries',
  audit_log: 'audit entries',
  secret_versions: 'old secret versions',
  invites: 'invites',
  password_resets: 'reset links',
  sessions: 'sign-ins',
}

function summary(r: Run): string {
  if (r.status === 'running') return 'Running…'
  const d = Object.entries(r.result?.deleted ?? {})
  if (d.length === 0) return r.error ? '' : 'Nothing needed deleting.'
  return 'Deleted ' + d.map(([k, n]) => `${n.toLocaleString()} ${LABELS[k] ?? k}`).join(', ')
}

/**
 * Built-in jobs: not tied to a project and not part of the Jobs module, so they can always be seen, stopped and
 * checked. Today that is the weekly data cleanup. Everyone who can see this can read the log; only the owner can
 * stop, resume or run it.
 */
export function SystemJobs() {
  const [jobs, setJobs] = useState<SystemJob[] | null>(null)
  const [editable, setEditable] = useState(false)
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<'run' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<{ jobs: SystemJob[]; editable: boolean }>('/api/system-jobs')
      setJobs(r.jobs)
      setEditable(r.editable)
      if (open || r.jobs[0]?.last_run?.status === 'running') {
        setRuns((await api<{ runs: Run[] }>(`/api/system-jobs/${r.jobs[0].key}/runs`)).runs)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [open])

  useEffect(() => {
    load()
  }, [load])

  // While a run is in progress, look again every couple of seconds.
  const running = jobs?.[0]?.last_run?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [running, load])

  if (!jobs) return error ? <ErrorBox error={error} /> : null
  const j = jobs[0]
  if (!j) return null

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ jobs: SystemJob[] }>(`/api/system-jobs/${j.key}`, { method: 'PATCH', body: { enabled: !j.enabled } })
      setJobs(r.jobs)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function runNow() {
    setBusy(true)
    setError(null)
    setAsk(null)
    try {
      await api(`/api/system-jobs/${j.key}/run`, { method: 'POST' })
      setOpen(true)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const last = j.last_run
  const state = !j.enabled ? 'disabled' : (last?.status ?? 'none')

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-medium text-zinc-200">
        System jobs <span className="text-xs font-normal text-zinc-500">· built in, not tied to a project</span>
      </h2>
      <ErrorBox error={error} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot status={state} />
              <span className="font-medium text-zinc-100">{j.name}</span>
              <Badge>system</Badge>
              {!j.enabled && <Badge tone="amber">stopped</Badge>}
              {last?.status === 'failed' && j.enabled && <Badge tone="red">last run failed</Badge>}
            </div>
            <p className="mt-1 max-w-xl text-xs text-zinc-400">{j.description}</p>
            <p className="mt-1 text-xs text-zinc-500">
              <span className="mono">{j.schedule}</span> · last run {last ? timeAgo(last.started_at) : 'never'} · next run{' '}
              {j.enabled ? (j.next_run_at ? `${timeAgo(j.next_run_at)} (${fmtTime(j.next_run_at)})` : 'soon') : '—'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide logs' : 'Logs'}</Button>
            {editable && (
              <>
                <Button variant="secondary" onClick={() => setAsk('run')} disabled={busy || running}>Run now</Button>
                <Button variant="secondary" onClick={toggle} disabled={busy}>{j.enabled ? 'Stop' : 'Resume'}</Button>
              </>
            )}
          </div>
        </div>
        {open && (
          <div className="border-t border-zinc-800">
            {!runs ? (
              <p className="px-4 py-3 text-sm text-zinc-500">Loading…</p>
            ) : runs.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-500">No runs yet. The first one is a week after it started, or press Run now.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-xs text-zinc-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Started</th>
                      <th className="px-4 py-2 font-medium">How</th>
                      <th className="px-4 py-2 font-medium">Result</th>
                      <th className="px-4 py-2 font-medium">Took</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {runs.map((r) => (
                      <tr key={r.id} className="align-top">
                        <td className="px-4 py-2 text-zinc-300">{fmtTime(r.started_at)}</td>
                        <td className="px-4 py-2 text-zinc-400">{r.trigger === 'manual' ? `by ${r.triggered_by ?? 'someone'}` : 'schedule'}</td>
                        <td className="px-4 py-2">
                          <Badge tone={r.status === 'success' ? 'green' : r.status === 'failed' ? 'red' : 'sky'}>{r.status}</Badge>{' '}
                          <span className="text-zinc-400">{summary(r)}</span>
                          {r.error && <div className="mt-1 text-xs text-red-400">{r.error}</div>}
                        </td>
                        <td className="px-4 py-2 text-zinc-400">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {ask === 'run' && (
        <Modal title="Run the cleanup now?" onClose={() => setAsk(null)}>
          <div className="space-y-3 text-sm text-zinc-300">
            <p>It permanently deletes everything that is past the times set in Settings → Data. There is no undo.</p>
            <p className="text-xs text-zinc-400">The next automatic run moves to a week from now.</p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
              <Button variant="danger" onClick={runNow}>Run cleanup</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
