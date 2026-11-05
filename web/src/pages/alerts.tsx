import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type AlertChannel, type AlertEventState, type AlertRecord, type ChannelType } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cx, fmtTime, timeAgo } from '../ui'

const TYPE_LABEL: Record<ChannelType, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', email: 'Email' }

const HELP: Record<ChannelType, string> = {
  telegram: 'Create a bot with @BotFather and copy its token. Add the bot to your group, then use the group’s chat ID (a negative number) — or @yourchannel for a public channel.',
  discord: 'In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
  slack: 'Create an Incoming Webhook at api.slack.com/apps (Incoming Webhooks → Add New Webhook to Workspace) and copy its URL.',
  email: 'Alerts are emailed to these addresses through the SMTP relay configured on the server.',
}

interface ChannelsResp {
  channels: AlertChannel[]
  smtp_configured: boolean
  smtp_host: string
}

export function AlertsPage() {
  const [data, setData] = useState<ChannelsResp | null>(null)
  const [events, setEvents] = useState<AlertEventState[] | null>(null)
  const [history, setHistory] = useState<AlertRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ existing?: AlertChannel } | null>(null)

  const loadChannels = useCallback(() => {
    api<ChannelsResp>('/api/alerts/channels').then(setData).catch((e) => setError(e.message))
  }, [])
  const loadEvents = useCallback(() => {
    api<{ events: AlertEventState[] }>('/api/alerts/events').then((r) => setEvents(r.events)).catch((e) => setError(e.message))
  }, [])
  const loadHistory = useCallback(() => {
    api<{ alerts: AlertRecord[] }>('/api/alerts/history?limit=50').then((r) => setHistory(r.alerts)).catch(() => {})
  }, [])

  useEffect(() => {
    loadChannels()
    loadEvents()
    loadHistory()
    const t = setInterval(loadHistory, 15_000)
    return () => clearInterval(t)
  }, [loadChannels, loadEvents, loadHistory])

  if (error && !data) return <ErrorBox error={error} persistent />
  if (!data || !events) return <Spinner />

  const activeChannels = data.channels.filter((c) => c.enabled).length

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Get told when a site goes down, a job fails, or a key or certificate is about to expire."
        actions={<Button onClick={() => setEditing({})}>Add channel</Button>}
      />
      <ErrorBox error={error} />

      <section className="mt-2">
        <h2 className="mb-3 font-medium text-zinc-200">Channels</h2>
        {data.channels.length === 0 ? (
          <Empty title="No channels yet">Add Telegram, Discord, Slack or email. Alerts go to every enabled channel, with the project and a link back here.</Empty>
        ) : (
          <div className="space-y-2">
            {data.channels.map((c) => (
              <ChannelRow key={c.id} channel={c} onEdit={() => setEditing({ existing: c })} onChanged={() => { loadChannels(); loadHistory() }} />
            ))}
          </div>
        )}
        {data.channels.length > 0 && activeChannels === 0 && (
          <p className="mt-2 text-sm text-amber-300">All channels are switched off — no alerts will be sent.</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-1 font-medium text-zinc-200">What to alert on</h2>
        <p className="mb-3 text-sm text-zinc-500">Each alert is sent once when something changes — not on every failed check.</p>
        <Card className="divide-y divide-zinc-800/70">
          {events.map((e) => (
            <EventRow key={e.key} event={e} onError={setError} onSaved={loadEvents} />
          ))}
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-medium text-zinc-200">Recent alerts</h2>
        {!history ? (
          <Spinner />
        ) : history.length === 0 ? (
          <Empty title="Nothing sent yet">Use “Test” on a channel to check that it works.</Empty>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Alert</th>
                  <th className="px-4 py-2.5 font-medium">Channel</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {history.map((h) => (
                  <tr key={h.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400" title={fmtTime(h.at)}>{timeAgo(h.at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="text-zinc-200">{h.title}</div>
                      <div className="text-xs text-zinc-500 mono">{h.event}</div>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300">{h.channel_name}</td>
                    <td className="px-4 py-2.5">
                      {h.status === 'sent' ? <Badge tone="green">sent</Badge> : <Badge tone="red">failed</Badge>}
                      {h.error && <div className="mt-1 max-w-xs text-xs text-red-300">{h.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {editing && (
        <ChannelModal
          existing={editing.existing}
          smtp={data.smtp_configured}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            loadChannels()
          }}
        />
      )}
    </>
  )
}

// ───────────────────────── channels ─────────────────────────

function ChannelRow({ channel: c, onEdit, onChanged }: { channel: AlertChannel; onEdit: () => void; onChanged: () => void }) {
  const [test, setTest] = useState<'idle' | 'sending' | { ok: boolean; error?: string }>('idle')
  const [err, setErr] = useState<string | null>(null)

  const toggle = async () => {
    setErr(null)
    try {
      await api(`/api/alerts/channels/${c.id}`, { method: 'PUT', body: { enabled: !c.enabled } })
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete the channel “${c.name}”?`)) return
    try {
      await api(`/api/alerts/channels/${c.id}`, { method: 'DELETE' })
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const runTest = async () => {
    setTest('sending')
    try {
      setTest(await api<{ ok: boolean; error?: string }>(`/api/alerts/channels/${c.id}/test`, { method: 'POST' }))
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message })
    }
    onChanged()
  }

  const link = 'text-xs text-zinc-400 hover:text-zinc-100'
  return (
    <Card className={cx('px-4 py-3', !c.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-100">{c.name}</span>
            <Badge tone="sky">{TYPE_LABEL[c.type]}</Badge>
            {!c.enabled && <Badge>off</Badge>}
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500 mono">{c.summary}</div>
        </div>
        <div className="flex items-center gap-4">
          <button className={link} onClick={runTest} disabled={test === 'sending'}>{test === 'sending' ? 'Sending…' : 'Send test'}</button>
          <button className={link} onClick={toggle}>{c.enabled ? 'Turn off' : 'Turn on'}</button>
          <button className={link} onClick={onEdit}>Edit</button>
          <button className={cx(link, 'hover:!text-red-400')} onClick={remove}>Delete</button>
        </div>
      </div>
      {test !== 'idle' && test !== 'sending' && (
        <div className={cx('mt-2 text-xs', test.ok ? 'text-emerald-400' : 'text-red-300')}>
          {test.ok ? '✓ Test alert sent — check the channel.' : `✗ ${test.error}`}
        </div>
      )}
      <ErrorBox error={err} />
    </Card>
  )
}

function ChannelModal({ existing, smtp, onClose, onSaved }: { existing?: AlertChannel; smtp: boolean; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<ChannelType>(existing?.type ?? 'telegram')
  const [name, setName] = useState(existing?.name ?? '')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState(existing?.type === 'telegram' ? existing.summary.replace('chat ', '') : '')
  const [webhook, setWebhook] = useState('')
  const [to, setTo] = useState(existing?.type === 'email' ? existing.summary.split(', ').join('\n') : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = !!existing
  const keep = editing ? 'Leave blank to keep the current one' : ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const config: Record<string, unknown> = {}
    if (type === 'telegram') {
      if (botToken) config.bot_token = botToken
      config.chat_id = chatId
    } else if (type === 'email') {
      config.to = to.split(/[\s,;]+/).filter(Boolean)
    } else if (webhook) {
      config.webhook_url = webhook
    }
    try {
      if (existing) await api(`/api/alerts/channels/${existing.id}`, { method: 'PUT', body: { name, enabled, config } })
      else await api('/api/alerts/channels', { method: 'POST', body: { type, name, enabled, config } })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? `Edit ${existing.name}` : 'Add channel'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!editing && (
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
              {(Object.keys(TYPE_LABEL) as ChannelType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </Select>
          </Field>
        )}
        <p className="text-xs text-zinc-500">{HELP[type]}</p>
        {type === 'email' && !smtp && (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
            Email isn’t set up on this server. Add <code>REXUS_SMTP_HOST</code> and <code>REXUS_SMTP_FROM</code> (and a login) to <code>.env</code>, then restart Rexus.
          </div>
        )}

        <Field label="Name" hint="Shown in Rexus only, e.g. “Ops team Slack”">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>

        {type === 'telegram' && (
          <>
            <Field label="Bot token" hint={keep}>
              <Input value={botToken} onChange={(e) => setBotToken(e.target.value)} className="mono" autoComplete="off" required={!editing} placeholder="123456789:AAH…" />
            </Field>
            <Field label="Chat ID">
              <Input value={chatId} onChange={(e) => setChatId(e.target.value)} className="mono" required placeholder="-1001234567890" />
            </Field>
          </>
        )}
        {(type === 'discord' || type === 'slack') && (
          <Field label="Webhook URL" hint={keep}>
            <Input
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              className="mono"
              autoComplete="off"
              required={!editing}
              placeholder={type === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://hooks.slack.com/services/…'}
            />
          </Field>
        )}
        {type === 'email' && (
          <Field label="Send to" hint="One or more addresses, separated by commas or new lines (max 10)">
            <Textarea value={to} onChange={(e) => setTo(e.target.value)} rows={3} required placeholder="ops@yourcompany.com" />
          </Field>
        )}

        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
          Enabled
        </label>
        <p className="text-xs text-zinc-500">Tokens and webhook URLs are stored encrypted and are never shown again.</p>

        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || (type === 'email' && !smtp)}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add channel'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

// ───────────────────────── events ─────────────────────────

function EventRow({ event: e, onError, onSaved }: { event: AlertEventState; onError: (m: string | null) => void; onSaved: () => void }) {
  const [daysText, setDaysText] = useState((e.days ?? []).join(', '))
  const [saved, setSaved] = useState(false)

  const save = async (enabled: boolean, text = daysText) => {
    onError(null)
    const body: Record<string, unknown> = { enabled }
    if (e.has_days) body.days = text.split(/[\s,;]+/).filter(Boolean).map(Number)
    try {
      await api(`/api/alerts/events/${e.key}`, { method: 'PUT', body })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 max-w-xl">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">{e.label}</span>
          {saved && <span className="text-xs text-emerald-400">saved</span>}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">{e.description}</p>
        {e.has_days && (
          <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
            Remind me
            <div className="w-32">
              <Input
                value={daysText}
                onChange={(ev) => setDaysText(ev.target.value)}
                onBlur={() => daysText !== (e.days ?? []).join(', ') && save(e.enabled)}
                onKeyDown={(ev) => ev.key === 'Enter' && (ev.preventDefault(), save(e.enabled))}
                className="py-1 mono"
                aria-label="Reminder days"
              />
            </div>
            days before expiry
          </div>
        )}
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={e.enabled} onChange={(ev) => save(ev.target.checked)} className="h-4 w-4 accent-emerald-500" />
        {e.enabled ? 'On' : 'Off'}
      </label>
    </div>
  )
}
