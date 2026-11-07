import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type AlertChannel, type AlertEventState, type AlertRecord, type ChannelType } from '../api'
import { Link, useSearchParams } from 'react-router-dom'
import { NavIcon } from '../icons'
import { ActionMenu, Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cx, fmtTime, timeAgo } from '../ui'

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

const ALERT_SECTIONS = [
  { id: 'delivery', label: 'Delivery history' },
  { id: 'channels', label: 'Channels' },
  { id: 'events', label: 'Event rules' },
] as const

export function AlertsPage() {
  const [params] = useSearchParams()
  const section = ALERT_SECTIONS.find((s) => s.id === params.get('view'))?.id ?? 'delivery'
  const [data, setData] = useState<ChannelsResp | null>(null)
  const [events, setEvents] = useState<AlertEventState[] | null>(null)
  const [history, setHistory] = useState<AlertRecord[] | null>(null)
  const [errors, setErrors] = useState<Partial<Record<typeof section, string>>>({})
  const [ruleError, setRuleError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<{ existing?: AlertChannel } | null>(null)

  const loadChannels = useCallback(async () => {
    try {
      setData(await api<ChannelsResp>('/api/alerts/channels'))
      setErrors((prev) => ({ ...prev, channels: undefined }))
    } catch (e) {
      setErrors((prev) => ({ ...prev, channels: (e as Error).message }))
    }
  }, [])
  const loadEvents = useCallback(async () => {
    try {
      const r = await api<{ events: AlertEventState[] }>('/api/alerts/events')
      setEvents(r.events)
      setErrors((prev) => ({ ...prev, events: undefined }))
    } catch (e) {
      setErrors((prev) => ({ ...prev, events: (e as Error).message }))
    }
  }, [])
  const loadHistory = useCallback(async () => {
    setRefreshing(true)
    try {
      const r = await api<{ alerts: AlertRecord[] }>('/api/alerts/history?limit=50')
      setHistory(r.alerts)
      setErrors((prev) => ({ ...prev, delivery: undefined }))
    } catch (e) {
      setErrors((prev) => ({ ...prev, delivery: (e as Error).message }))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadChannels()
    void loadEvents()
    void loadHistory()
    const timer = setInterval(loadHistory, 15_000)
    return () => clearInterval(timer)
  }, [loadChannels, loadEvents, loadHistory])

  const enabledChannels = data?.channels.filter((c) => c.enabled).length
  const failed = history?.filter((h) => h.status === 'failed').length
  const metrics = [
    { label: 'Active channels', value: data ? `${enabledChannels} / ${data.channels.length}` : '—', hint: 'Enabled destinations' },
    { label: 'Sent', value: history ? history.length - (failed ?? 0) : '—', hint: 'Last 50 deliveries' },
    { label: 'Failed', value: failed ?? '—', hint: 'Last 50 deliveries' },
  ]
  const channelChanged = () => { void loadChannels(); void loadHistory() }

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Manage notification destinations, event rules, and delivery."
        actions={<Button onClick={() => setEditing({})}>Add channel</Button>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {metrics.map((metric) => (
          <Card key={metric.label} className="px-4 py-3">
            <div className="text-xs font-medium text-zinc-400">{metric.label}</div>
            <div className={cx('mt-1 text-xl font-semibold tabular-nums', metric.label === 'Failed' && failed ? 'text-red-300' : 'text-zinc-50')}>{metric.value}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{metric.hint}</div>
          </Card>
        ))}
      </div>

      {enabledChannels === 0 && (
        <div className="mb-4 rounded-md border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {data?.channels.length ? 'All channels are turned off.' : 'No notification channels are configured.'}{' '}
          <Link to="?view=channels" className="font-medium underline underline-offset-2">Manage channels</Link>
        </div>
      )}

      <nav aria-label="Alert settings" className="mb-5 flex flex-wrap gap-x-5 border-b border-zinc-800">
        {ALERT_SECTIONS.map(({ id, label }) => (
          <Link
            key={id}
            to={id === 'delivery' ? '/alerts' : `?view=${id}`}
            aria-current={section === id ? 'page' : undefined}
            className={cx('border-b-2 px-1 py-2.5 text-sm font-medium', section === id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-100')}
          >{label}</Link>
        ))}
      </nav>

      <ErrorBox error={errors[section] ?? null} persistent />
      {section === 'delivery' && <DeliveryHistory history={history} refreshing={refreshing} reload={loadHistory} />}
      {section === 'channels' && (
        <section aria-label="Channels">
          <h2 className="mb-1 text-sm font-medium text-zinc-100">Notification destinations</h2>
          <p className="mb-3 text-sm text-zinc-400">Manage delivery, send a test, or configure Telegram’s daily digest and /status.</p>
          {!data ? (errors.channels ? null : <Spinner />) : data.channels.length === 0 ? (
            <Empty title="No channels yet">Add Telegram, Discord, Slack or email to receive alerts.</Empty>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {data.channels.map((c) => (
                <ChannelRow key={c.id} channel={c} onEdit={() => setEditing({ existing: c })} onChanged={channelChanged} />
              ))}
            </div>
          )}
        </section>
      )}
      {section === 'events' && (
        <section aria-label="Event rules">
          <h2 className="mb-1 text-sm font-medium text-zinc-100">What triggers an alert</h2>
          <p className="mb-3 text-sm text-zinc-400">Enabled events go to every active channel.</p>
          <ErrorBox error={ruleError} />
          {events ? (
            <Card className="divide-y divide-zinc-800/70">
              {events.map((event) => <EventRow key={event.key} event={event} onError={setRuleError} onSaved={loadEvents} />)}
            </Card>
          ) : errors.events ? null : <Spinner />}
        </section>
      )}

      {editing && (
        <ChannelModal
          existing={editing.existing}
          smtp={data?.smtp_configured ?? false}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void loadChannels()
          }}
        />
      )}
    </>
  )
}

function DeliveryHistory({ history, refreshing, reload }: { history: AlertRecord[] | null; refreshing: boolean; reload: () => void }) {
  const [result, setResult] = useState('')
  const [channel, setChannel] = useState('')
  const destinations = [...new Set(history?.map((h) => h.channel_name))].sort()
  const activeChannel = destinations.includes(channel) ? channel : ''
  const shown = history?.filter((h) => (!result || h.status === result) && (!activeChannel || h.channel_name === activeChannel))

  return (
    <section aria-label="Delivery history">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Recent deliveries</h2>
          <p className="mt-1 text-xs text-zinc-400">{history ? `${shown?.length} of ${history.length} recent deliveries` : 'Up to 50 recent deliveries'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-auto! max-w-full" aria-label="Filter by delivery result" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">All results</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </Select>
          <Select className="w-auto! max-w-full" aria-label="Filter by channel" value={activeChannel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {destinations.map((name) => <option key={name}>{name}</option>)}
          </Select>
          <Button variant="secondary" disabled={refreshing} onClick={reload}><NavIcon name="refresh" size={15} /> Refresh</Button>
        </div>
      </div>
      {!shown ? (refreshing ? <Spinner /> : null) : shown.length === 0 ? (
        <Empty title={history?.length ? 'No matching deliveries' : 'No deliveries yet'}>
          {history?.length ? 'Try a different channel or result.' : <>Use <b>Send test</b> on the <Link to="?view=channels" className="text-emerald-400 hover:underline">Channels</Link> tab to verify delivery.</>}
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
              <tr>{['Alert', 'Channel', 'Result', 'When'].map((heading) => <th key={heading} scope="col" className="px-4 py-2.5 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {shown.map((h) => (
                <tr key={h.id} className="align-top hover:bg-zinc-800/25">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-200">{h.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{h.event}{h.project_key && ` · ${h.project_key}`}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{h.channel_name}</td>
                  <td className="px-4 py-3">
                    <Badge tone={h.status === 'sent' ? 'green' : 'red'}>{h.status === 'sent' ? 'Sent' : 'Failed'}</Badge>
                    {h.error && <div className="mt-1 max-w-xs break-words text-xs text-red-300">{h.error}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400" title={fmtTime(h.at)}>{timeAgo(h.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
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

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words font-medium text-zinc-100">{c.name}</h3>
            <Badge tone="sky">{TYPE_LABEL[c.type]}</Badge>
            <Badge tone={c.enabled ? 'green' : 'zinc'}>{c.enabled ? 'Active' : 'Off'}</Badge>
          </div>
          <div className="mt-1 break-words text-xs text-zinc-400">{c.summary}</div>
        </div>
        <ActionMenu label={`More actions for ${c.name}`} items={[
          { label: c.enabled ? 'Turn off' : 'Turn on', onClick: toggle },
          { label: 'Delete channel', onClick: remove, danger: true },
        ]} />
      </div>
      {c.type === 'telegram' && (
        <dl className="mt-4 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-xs">
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="text-zinc-400">Daily digest</dt><dd className="text-zinc-200">{c.digest?.time ? `${c.digest.time} · ${c.digest.timezone}` : 'Off'}</dd></div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="text-zinc-400">/status replies</dt><dd className="text-zinc-200">{c.command_chat_id ? `Chat ${c.command_chat_id}` : 'Off'}</dd></div>
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onEdit}>Configure</Button>
        <Button variant="ghost" onClick={runTest} disabled={test === 'sending'}>{test === 'sending' ? 'Sending…' : 'Send test'}</Button>
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
  const [commandChatId, setCommandChatId] = useState(existing?.command_chat_id ?? '')
  const [digestEnabled, setDigestEnabled] = useState(!!existing?.digest?.time)
  const [digestTime, setDigestTime] = useState(existing?.digest?.time || '09:00')
  const [digestTimezone, setDigestTimezone] = useState(existing?.digest?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
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
      config.command_chat_id = commandChatId
      config.digest = { time: digestEnabled ? digestTime : '', timezone: digestTimezone }
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
            <Field label="Chat ID for /status" hint="Use a private team group, DM, or channel whose members can see workspace status. Leave blank to turn replies off.">
              <Input value={commandChatId} onChange={(e) => setCommandChatId(e.target.value)} className="mono" placeholder="-1001234567890" />
            </Field>
            {/^-?[1-9]\d*$/.test(chatId.trim()) && (
              <button type="button" className="text-xs text-emerald-400 hover:underline" onClick={() => setCommandChatId(chatId.trim())}>
                Use the alert chat for /status
              </button>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={digestEnabled} onChange={(e) => setDigestEnabled(e.target.checked)} className="accent-emerald-500" />
              Send a daily digest to the alert chat
            </label>
            {digestEnabled && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Digest time">
                  <Input type="time" value={digestTime} onChange={(e) => setDigestTime(e.target.value)} required />
                </Field>
                <Field label="Timezone">
                  <Input value={digestTimezone} onChange={(e) => setDigestTimezone(e.target.value)} placeholder="Asia/Kolkata" required />
                </Field>
              </div>
            )}
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
