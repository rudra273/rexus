import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Spinner, Tabs } from '../ui'

interface InstanceSettings {
  company_name: string
  base_url: string
  version: string
  toggles: Record<string, string>
  smtp?: { configured: boolean; host: string }
  /** The owner and admins can change the company name and public URL. */
  editable: boolean
  /** Where each of these comes from: the .env file, or saved from this page. */
  sources: Record<'company_name' | 'base_url' | 'module_vault' | 'module_scheduler' | 'backup_enabled', 'env' | 'ui'>
  /** The values from .env, which apply wherever nothing is saved. */
  defaults: { company_name: string; base_url: string; modules: Modules }
  /** The module switches as they are now. */
  modules: Modules
  /** Backups can only be switched on when REXUS_BACKUP_DIR is set (it is a folder mounted into the container). */
  backup_dir_set: boolean
}

interface Modules {
  vault: boolean
  scheduler: boolean
  backups: boolean
}

type Tab = 'general' | 'modules' | 'security' | 'notifications' | 'backups'

/**
 * App-wide configuration. The company name and public URL can be changed here by the owner or an admin (saved in the
 * database; the .env values are the defaults). Everything else is still set on the server in .env and is
 * shown read-only. Personal settings live in Profile.
 */
export function SettingsPage() {
  const { meta, refresh } = useAuth()
  const [params, setParams] = useSearchParams()
  const [instance, setInstance] = useState<InstanceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<InstanceSettings>('/api/settings').then(setInstance).catch((e) => setError(e.message))
  }, [])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'modules', label: 'Modules' },
    { id: 'security', label: 'Security policy' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'backups', label: 'Backups' },
  ]
  const requested = params.get('tab')
  const tab: Tab = tabs.some((t) => t.id === requested) ? (requested as Tab) : 'general'

  if (error && !instance) return <ErrorBox error={error} persistent />
  if (!instance || !meta) return <Spinner />

  const t = instance.toggles
  const val = (k: string, fallback = '—') => t[k] ?? fallback

  return (
    <>
      <PageHeader title="Settings" subtitle={<>App-wide configuration. Your own password, 2FA and display options are in <Link to="/profile" className="text-emerald-400 hover:underline">Profile</Link>.</>} />
      <Tabs tabs={tabs} value={tab} onChange={(id) => setParams(id === 'general' ? {} : { tab: id }, { replace: true })} label="Settings sections" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="max-w-2xl space-y-4">
        {(tab === 'security' || tab === 'notifications') && <ManagedNote />}

        {tab === 'general' && (
          <>
            {instance.editable ? (
              <GeneralForm
                instance={instance}
                onSaved={async (next) => {
                  setInstance(next)
                  await refresh() // the company name is also in the sidebar and the page title
                }}
              />
            ) : (
              <>
                <Card className="divide-y divide-zinc-800">
                  <Row label="Company name" value={instance.company_name} managed={false} />
                  <Row label="Public URL" value={<span className="mono">{instance.base_url}</span>} managed={false} />
                </Card>
                <p className="text-sm text-zinc-400">You can't change these.</p>
              </>
            )}
            <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span>Rexus <span className="mono">{instance.version}</span></span>
              {val('REXUS_ENV') === 'development' && <Badge tone="amber">Development mode</Badge>}
            </p>
          </>
        )}

        {tab === 'modules' && (
          <ModulesForm
            instance={instance}
            onSaved={async (next) => {
              setInstance(next)
              await refresh() // the sidebar and pages follow the switches
            }}
          />
        )}

        {tab === 'security' && (
          <Card className="divide-y divide-zinc-800">
            <Row
              label="Two-factor requirement"
              help="REXUS_2FA_MODE"
              value={TWO_FA[meta.two_fa_mode] ?? meta.two_fa_mode}
            />
            <Row
              label="Owner-only sign-in (lockdown)"
              help="REXUS_LOGIN_OWNER_ONLY"
              value={<OnOff on={val('REXUS_LOGIN_OWNER_ONLY', 'false') === 'true'} />}
            />
            <Row
              label="Allowed IP addresses"
              help="REXUS_IP_ALLOWLIST"
              value={ipValue(val('REXUS_IP_ALLOWLIST', ''))}
            />
          </Card>
        )}

        {tab === 'notifications' && (
          <>
            <Card className="divide-y divide-zinc-800">
              <Row
                label="Email (SMTP)"
                help="REXUS_SMTP_*"
                value={instance.smtp?.configured ? <span className="mono">{instance.smtp.host}</span> : <span className="text-zinc-500">not set up</span>}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <div className="text-zinc-200">Alert channels and events</div>
                  <div className="text-xs text-zinc-500">Telegram, Slack, Discord and email channels, and which events send alerts.</div>
                </div>
                <Link to="/alerts" className="text-emerald-400 hover:underline">Open Alerts</Link>
              </div>
            </Card>
          </>
        )}

        {tab === 'backups' && (
          <Card className="divide-y divide-zinc-800">
            <Row label="Backups" value={<OnOff on={meta.backup_enabled} />} managed={false} />
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <div className="text-zinc-200">Schedule, retention and history</div>
                <div className="text-xs text-zinc-500">
                  {meta.backup_enabled
                    ? 'Edited on the Backups page, which is the one place for these settings.'
                    : instance.backup_dir_set
                      ? <>Switch backups on under <Link to="/settings?tab=modules" className="text-emerald-400 hover:underline">Modules</Link>.</>
                      : 'Set REXUS_BACKUP_DIR in .env and restart Rexus. After that you can switch backups on under Modules.'}
                </div>
              </div>
              {meta.backup_enabled && <Link to="/backups" className="text-emerald-400 hover:underline">Open Backups</Link>}
            </div>
          </Card>
        )}
      </div>
    </>
  )
}

const TWO_FA: Record<string, string> = {
  required: 'Required for everyone',
  admins: 'Required for owner and admins',
  optional: 'Optional — each person chooses',
  off: 'Off',
}

function ipValue(v: string): ReactNode {
  if (v === '' || v === '0.0.0.0') return 'Anyone (no restriction)'
  return <span className="mono">{v}</span>
}

function publicUrlWarning(url: string): string {
  return `Change the public URL to ${url}?\n\nThis address goes into the links Rexus emails (invites, password resets, alerts). Login cookies are marked secure only for https:// addresses, so a wrong address can stop new sign-ins from working.\n\nIf that happens, run "rexus settings reset" on the server to go back to the .env value.`
}

/** The company name and public URL, for the owner. Saved in the database; the .env values are the defaults. */
function GeneralForm({ instance, onSaved }: { instance: InstanceSettings; onSaved: (next: InstanceSettings) => Promise<void> }) {
  const [name, setName] = useState(instance.company_name)
  const [url, setUrl] = useState(instance.base_url)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState(false)
  const nameChanged = name.trim() !== instance.company_name
  const urlChanged = url.trim().replace(/\/+$/, '').toLowerCase() !== instance.base_url.toLowerCase()

  async function send(body: { company_name?: string; base_url?: string }) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api<InstanceSettings>('/api/settings', { method: 'PUT', body })
      setName(next.company_name)
      setUrl(next.base_url)
      await onSaved(next)
      setSaved(true)
      setEditing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) {
      setError('Enter a value, or use “Use the default” to go back to the value from .env.')
      return
    }
    if (urlChanged && !confirm(publicUrlWarning(url.trim()))) return
    await send({ ...(nameChanged && { company_name: name }), ...(urlChanged && { base_url: url }) })
  }

  async function useDefault(field: 'company_name' | 'base_url') {
    if (field === 'base_url' && !confirm(publicUrlWarning(instance.defaults.base_url))) return
    await send({ [field]: '' })
  }

  const source = (field: 'company_name' | 'base_url') =>
    instance.sources[field] === 'ui' ? (
      <>
        Saved here. The default from .env is <span className="mono">{instance.defaults[field]}</span>.{' '}
        <button type="button" disabled={busy} onClick={() => useDefault(field)} className="text-emerald-400 hover:underline disabled:opacity-50">Use the default</button>
      </>
    ) : (
      'From the .env file. Saving a value here overrides it.'
    )

  function startEditing() {
    setName(instance.company_name)
    setUrl(instance.base_url)
    setError(null)
    setSaved(false)
    setEditing(true)
  }

  function cancel() {
    setName(instance.company_name)
    setUrl(instance.base_url)
    setError(null)
    setEditing(false)
  }

  if (!editing) {
    const where = (field: 'company_name' | 'base_url') =>
      instance.sources[field] === 'ui' ? <>Saved here. Default from .env: <span className="mono">{instance.defaults[field]}</span></> : 'From the .env file'
    return (
      <div className="space-y-4">
        <Card className="divide-y divide-zinc-800">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <div className="min-w-0">
              <div className="text-zinc-200">Company name</div>
              <div className="text-xs text-zinc-400">{where('company_name')}</div>
            </div>
            <span className="min-w-0 break-words text-right text-zinc-100">{instance.company_name}</span>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <div className="min-w-0">
              <div className="text-zinc-200">Public URL</div>
              <div className="text-xs text-zinc-400">{where('base_url')}</div>
            </div>
            <span className="mono min-w-0 break-words text-right text-zinc-100">{instance.base_url}</span>
          </div>
        </Card>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={startEditing}>Edit</Button>
          {saved && <span role="status" className="text-sm text-emerald-400">Saved</span>}
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card className="space-y-5 p-4">
        <Field label="Company name" hint={<>Shown in the sidebar, the page title and emails. {source('company_name')}</>}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </Field>
        <Field label="Public URL" hint={<>Used in the links Rexus emails (invites, password resets, alerts). {source('base_url')}</>}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://rexus.example.com" />
        </Field>
      </Card>
      <ErrorBox error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !(nameChanged || urlChanged)}>{busy ? 'Saving…' : 'Save changes'}</Button>
        <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

const MODULES: { key: keyof Modules; source: 'module_vault' | 'module_scheduler' | 'backup_enabled'; label: string; what: string; whenOff: string }[] = [
  {
    key: 'vault', source: 'module_vault', label: 'Vault',
    what: 'Secrets and environments, and the deploy tokens that apps use to fetch them.',
    whenOff: 'Vault: the Vault pages and the secrets API disappear, and deploy tokens stop working, so apps that fetch their environment variables from Rexus when they start will fail to start.',
  },
  {
    key: 'scheduler', source: 'module_scheduler', label: 'Jobs (scheduler)',
    what: 'Your scheduled jobs, such as keep-alive pings. Health checks always run.',
    whenOff: 'Jobs: your scheduled jobs, including keep-alive pings, stop running. Health checks keep running.',
  },
  {
    key: 'backups', source: 'backup_enabled', label: 'Backups',
    what: 'Scheduled and manual backups of the database.',
    whenOff: 'Backups: scheduled backups stop and “Backup now” is disabled. Backup files you already have stay where they are.',
  },
]

/** Vault, Jobs and Backups on or off. Saved in the database; the .env values are the defaults. Nothing is deleted when a module is off. */
function ModulesForm({ instance, onSaved }: { instance: InstanceSettings; onSaved: (next: InstanceSettings) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Modules>(instance.modules)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const anySaved = MODULES.some((m) => instance.sources[m.source] === 'ui')
  const changed = MODULES.filter((m) => draft[m.key] !== instance.modules[m.key])

  async function send(body: { modules?: Partial<Modules>; reset_modules?: boolean }, willBeOff: (typeof MODULES)[number][]) {
    if (willBeOff.length > 0 && !confirm(`Switch off ${willBeOff.map((m) => m.label).join(', ')}?\n\n${willBeOff.map((m) => m.whenOff).join('\n\n')}\n\nNothing is deleted. Switching a module back on brings it back as it was.`)) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api<InstanceSettings>('/api/settings', { method: 'PUT', body })
      await onSaved(next)
      setSaved(true)
      setEditing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function startEditing() {
    setDraft(instance.modules)
    setError(null)
    setSaved(false)
    setEditing(true)
  }

  const badge = (m: (typeof MODULES)[number]) => (instance.sources[m.source] === 'ui' ? <>Saved here. Default from .env: {instance.defaults.modules[m.key] ? 'on' : 'off'}</> : 'From the .env file')
  const needsFolder = (m: (typeof MODULES)[number]) => m.key === 'backups' && !instance.backup_dir_set

  if (!editing) {
    return (
      <div className="space-y-4">
        <Card className="divide-y divide-zinc-800">
          {MODULES.map((m) => (
            <div key={m.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="text-zinc-200">{m.label}</div>
                <div className="text-xs text-zinc-400">{m.what}</div>
                <div className="text-xs text-zinc-400">{badge(m)}</div>
              </div>
              <OnOff on={instance.modules[m.key]} />
            </div>
          ))}
        </Card>
        {!instance.backup_dir_set && !instance.modules.backups && (
          <p className="text-xs text-zinc-400">Backups can't be switched on yet: set <code>REXUS_BACKUP_DIR</code> in <code>.env</code> (a folder for the backup files) and restart Rexus.</p>
        )}
        <div className="flex items-center gap-3">
          {instance.editable && <Button variant="secondary" onClick={startEditing}>Edit</Button>}
          {saved && <span role="status" className="text-sm text-emerald-400">Saved</span>}
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        void send({ modules: Object.fromEntries(changed.map((m) => [m.key, draft[m.key]])) }, changed.filter((m) => !draft[m.key]))
      }}
      className="space-y-4"
    >
      <Card className="divide-y divide-zinc-800">
        {MODULES.map((m) => (
          <label key={m.key} className="flex cursor-pointer items-start gap-3 px-4 py-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-emerald-500"
              checked={draft[m.key]}
              disabled={busy || (needsFolder(m) && !draft[m.key])}
              onChange={(e) => setDraft({ ...draft, [m.key]: e.target.checked })}
            />
            <span className="min-w-0">
              <span className="block text-zinc-200">{m.label}</span>
              <span className="block text-xs text-zinc-400">{m.what}</span>
              {needsFolder(m) && <span className="block text-xs text-amber-300">Needs a backup folder: set REXUS_BACKUP_DIR in .env and restart Rexus.</span>}
            </span>
          </label>
        ))}
      </Card>
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || changed.length === 0}>{busy ? 'Saving…' : 'Save changes'}</Button>
        <Button type="button" variant="ghost" onClick={() => { setError(null); setEditing(false) }} disabled={busy}>Cancel</Button>
        {anySaved && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void send({ reset_modules: true }, MODULES.filter((m) => instance.modules[m.key] && !instance.defaults.modules[m.key]))}
            className="ml-auto"
          >
            Use the defaults from .env
          </Button>
        )}
      </div>
    </form>
  )
}

function ManagedNote() {
  return (
    <p className="text-sm text-zinc-400">
      These are set on the server in the <code>.env</code> file, so they can't be changed from here. After editing <code>.env</code>, restart Rexus for the change to take effect.
    </p>
  )
}

function OnOff({ on }: { on: boolean }) {
  return on ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>
}

function Row({ label, value, help, managed = true }: { label: string; value: ReactNode; help?: string; managed?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="text-zinc-200">{label}</div>
        {help && <div className="mono text-xs text-zinc-500">{help}</div>}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 break-words text-right text-zinc-200">{value}</span>
        {managed && <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">Managed on server</span>}
      </div>
    </div>
  )
}
