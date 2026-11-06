import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { applyAccent, type Look } from '../brand'
import { timezoneList } from '../prefs'
import { Badge, Button, Card, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Tabs } from '../ui'

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
  /** Timezone, date format, accent colour and logo for everyone. */
  look: Look
  session_hours: number
  defaults_look: { session_hours: number }
  max_logo_kb: number
}

interface Modules {
  vault: boolean
  scheduler: boolean
  backups: boolean
}

type Tab = 'general' | 'modules' | 'security' | 'notifications'

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
  ]
  const requested = params.get('tab')
  const tab: Tab = tabs.some((t) => t.id === requested) ? (requested as Tab) : 'general'

  if (error && !instance) return <ErrorBox error={error} persistent />
  if (!instance || !meta) return <Spinner />

  const t = instance.toggles
  const val = (k: string, fallback = '—') => t[k] ?? fallback

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <span className="flex items-center gap-2 text-xs text-zinc-400">
            {val('REXUS_ENV') === 'development' && <Badge tone="amber">Development mode</Badge>}
            <span>Rexus <span className="mono">v{instance.version}</span></span>
          </span>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={(id) => setParams(id === 'general' ? {} : { tab: id }, { replace: true })} label="Settings sections" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="max-w-3xl space-y-4">
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
          <>
          <SessionsForm instance={instance} onSaved={async (next) => setInstance(next)} />
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
          </>
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

const SESSION_CHOICES: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
]


function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
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

/** One setting: the name and a short explanation on the left, the control on the right. */
function SettingRow({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:items-center">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium text-zinc-200">{label}</label>
        {hint && <div className="mt-0.5 text-xs text-zinc-400">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function readFile(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read that file.'))
    r.readAsDataURL(f)
  })
}

/** General: name, address, logo and colour, regional defaults and session length. One save bar for everything. */
function GeneralForm({ instance, onSaved }: { instance: InstanceSettings; onSaved: (next: InstanceSettings) => Promise<void> }) {
  const initial = () => ({
    name: instance.company_name,
    url: instance.base_url,
    logo: undefined as string | undefined, // undefined = unchanged, '' = remove, anything else = new image
    accent: instance.look.accent_color,
    timezone: instance.look.timezone,
    dateFormat: instance.look.date_format,
  })
  const [d, setD] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const known = timezoneList()
  // A saved zone the browser lists under another name (Asia/Kolkata vs Asia/Calcutta) still has to show.
  const zones = !instance.look.timezone || known.includes(instance.look.timezone) ? known : [instance.look.timezone, ...known]
  const fileRef = useRef<HTMLInputElement>(null)

  const nameChanged = d.name.trim() !== instance.company_name
  const urlChanged = d.url.trim().replace(/\/+$/, '').toLowerCase() !== instance.base_url.toLowerCase()
  const logoChanged = d.logo !== undefined
  const accentChanged = d.accent.toLowerCase() !== instance.look.accent_color.toLowerCase()
  const tzChanged = d.timezone !== instance.look.timezone
  const fmtChanged = d.dateFormat !== instance.look.date_format
  const dirty = nameChanged || urlChanged || logoChanged || accentChanged || tzChanged || fmtChanged

  // Show the colour while it is being picked; go back to the saved one if the page is left without saving.
  useEffect(() => {
    applyAccent(d.accent)
  }, [d.accent])
  useEffect(() => () => applyAccent(instance.look.accent_color), [instance.look.accent_color])

  const set = (patch: Partial<ReturnType<typeof initial>>) => {
    setSaved(false)
    setD((x) => ({ ...x, ...patch }))
  }

  async function pickLogo(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.size > instance.max_logo_kb * 1024) {
      setError(`That image is ${Math.ceil(file.size / 1024)} KB. The limit is ${instance.max_logo_kb} KB.`)
      return
    }
    try {
      set({ logo: await readFile(file) })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!d.name.trim() || !d.url.trim()) {
      setError('Enter a company name and a public URL.')
      return
    }
    if (urlChanged && !confirm(publicUrlWarning(d.url.trim()))) return
    const body = {
      ...(nameChanged && { company_name: d.name }),
      ...(urlChanged && { base_url: d.url }),
      ...(logoChanged && { logo: d.logo }),
      ...(accentChanged && { accent_color: d.accent }),
      ...(tzChanged && { timezone: d.timezone }),
      ...(fmtChanged && { date_format: d.dateFormat === 'system' ? '' : d.dateFormat }),
    }
    setBusy(true)
    setError(null)
    try {
      const next = await api<InstanceSettings>('/api/settings', { method: 'PUT', body })
      await onSaved(next)
      setD({
        name: next.company_name, url: next.base_url, logo: undefined, accent: next.look.accent_color,
        timezone: next.look.timezone, dateFormat: next.look.date_format,
      })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500) // the bar goes away by itself
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function discard() {
    setD(initial())
    setError(null)
  }

  const logoSrc = d.logo === undefined ? instance.look.logo_url : d.logo
  const hasCustomLogo = d.logo === undefined ? !!instance.look.logo_url : d.logo !== ''
  return (
    <form onSubmit={submit} className="space-y-6">
      <Section title="Workspace" description="How this instance is named and reached.">
        <SettingRow label="Company name" hint="Shown in the sidebar, the browser tab and emails." htmlFor="g-name">
          <Input id="g-name" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
        </SettingRow>
        <SettingRow label="Public URL" hint="The address people use to reach Rexus. It goes into emailed links." htmlFor="g-url">
          <Input id="g-url" value={d.url} onChange={(e) => set({ url: e.target.value })} inputMode="url" placeholder="https://rexus.example.com" />
        </SettingRow>
        <SettingRow label="Logo" hint={`PNG, JPEG, WebP or SVG, up to ${instance.max_logo_kb} KB.`}>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
              <img src={logoSrc || '/favicon.svg'} alt="" className="h-9 w-9 object-contain" />
            </span>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" aria-label="Upload a logo"
              onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = '' }} />
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>Upload</Button>
            {hasCustomLogo && <Button type="button" variant="ghost" onClick={() => set({ logo: d.logo === undefined || instance.look.logo_url ? '' : undefined })}>Remove</Button>}
          </div>
        </SettingRow>
      </Section>

      <Section title="Regional" description="Defaults for everyone. Each person can pick their own in Profile.">
        <SettingRow label="Timezone" hint="Used for every date and time shown in Rexus." htmlFor="g-tz">
          <Select id="g-tz" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            <option value="">Each person’s browser</option>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        </SettingRow>
        <SettingRow label="Date format" htmlFor="g-fmt">
          <Select id="g-fmt" value={d.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>
            <option value="system">Each person’s browser</option>
            <option value="iso">2026-11-05 14:32 (year first)</option>
            <option value="dmy">05/11/2026 (day first)</option>
            <option value="mdy">11/5/2026 (month first)</option>
          </Select>
        </SettingRow>
      </Section>

      <ErrorBox error={error} />

      {(dirty || saved || busy) && (
      <div className="sticky bottom-4 z-10">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 shadow-lg">
          <span className="text-sm text-zinc-300" role="status">{dirty ? 'You have unsaved changes' : saved ? <span className="text-emerald-400">Saved</span> : ''}</span>
          <div className="flex items-center gap-2">
            {dirty && <Button type="button" variant="ghost" onClick={discard} disabled={busy}>Discard</Button>}
            {(dirty || busy) && <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>}
          </div>
        </div>
      </div>
      )}
    </form>
  )
}

/** How long people stay signed in. Lives under Security. */
function SessionsForm({ instance, onSaved }: { instance: InstanceSettings; onSaved: (next: InstanceSettings) => Promise<void> }) {
  const [hours, setHours] = useState(instance.session_hours)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const dirty = hours !== instance.session_hours
  const options = SESSION_CHOICES.some((c) => c.hours === hours)
    ? SESSION_CHOICES
    : [...SESSION_CHOICES, { hours, label: `${hours} hours` }].sort((a, b) => a.hours - b.hours)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const next = await api<InstanceSettings>('/api/settings', {
        method: 'PUT',
        body: { session_hours: hours === instance.defaults_look.session_hours ? 0 : hours },
      })
      await onSaved(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Sessions" description="How long people stay signed in.">
      <SettingRow label="Sign out after inactivity" hint="Applies to new activity. Someone who is active stays signed in." htmlFor="g-hours">
        <div className="flex items-center gap-3">
          <Select id="g-hours" value={hours} disabled={!instance.editable || busy} onChange={(e) => { setSaved(false); setHours(Number(e.target.value)) }}>
            {options.map((c) => <option key={c.hours} value={c.hours}>{c.label}{c.hours === instance.defaults_look.session_hours ? ' (default)' : ''}</option>)}
          </Select>
          {dirty && <Button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}
          {saved && !dirty && <span role="status" className="text-sm text-emerald-400">Saved</span>}
        </div>
        {error && <div className="mt-2"><ErrorBox error={error} /></div>}
      </SettingRow>
    </Section>
  )
}

const MODULES: { key: keyof Modules; source: 'module_vault' | 'module_scheduler' | 'backup_enabled'; label: string; what: string; whenOff: string }[] = [
  {
    key: 'vault', source: 'module_vault', label: 'Vault',
    what: 'Secrets, environments and deploy tokens.',
    whenOff: 'Vault: the Vault pages and the secrets API disappear, and deploy tokens stop working, so apps that fetch their environment variables from Rexus when they start will fail to start.',
  },
  {
    key: 'scheduler', source: 'module_scheduler', label: 'Jobs (scheduler)',
    what: 'Scheduled jobs and keep-alive pings.',
    whenOff: 'Jobs: your scheduled jobs, including keep-alive pings, stop running. Health checks keep running.',
  },
  {
    key: 'backups', source: 'backup_enabled', label: 'Backups',
    what: 'Download database backups.',
    whenOff: 'Backups: the Backups page and “Backup now” go away. Backup files you already downloaded are not affected.',
  },
]

/** What switching a module on does, for the confirm popup. */
const WHEN_ON: Record<keyof Modules, string> = {
  vault: 'Vault: the Vault pages and the secrets API come back, and deploy tokens work again.',
  scheduler: 'Jobs: your scheduled jobs start running again.',
  backups: 'Backups: the Backups page and “Backup now” come back.',
}

type Pending = { title: string; body: string[]; confirmLabel: string; danger: boolean; send: { modules?: Partial<Modules>; reset_modules?: boolean } }

/** Vault, Jobs and Backups: one switch each. Every change asks first, then saves at once. Saved in the database; the .env values are the defaults. Nothing is deleted when a module is off. */
function ModulesForm({ instance, onSaved }: { instance: InstanceSettings; onSaved: (next: InstanceSettings) => Promise<void> }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const anySaved = MODULES.some((m) => instance.sources[m.source] === 'ui')

  async function confirmIt() {
    if (!pending) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api<InstanceSettings>('/api/settings', { method: 'PUT', body: pending.send })
      await onSaved(next)
      setSaved(true)
      setPending(null)
    } catch (e) {
      setError((e as Error).message)
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  function ask(m: (typeof MODULES)[number]) {
    const turnOn = !instance.modules[m.key]
    setSaved(false)
    setError(null)
    setPending(
      turnOn
        ? { title: `Switch on ${m.label}?`, body: [WHEN_ON[m.key]], confirmLabel: 'Switch on', danger: false, send: { modules: { [m.key]: true } } }
        : { title: `Switch off ${m.label}?`, body: [m.whenOff, 'Nothing is deleted. Switching it back on brings it back as it was.'], confirmLabel: 'Switch off', danger: true, send: { modules: { [m.key]: false } } },
    )
  }

  function askReset() {
    const off = MODULES.filter((m) => instance.modules[m.key] && !instance.defaults.modules[m.key])
    setSaved(false)
    setError(null)
    setPending({
      title: 'Reset to defaults?',
      body: [
        'Vault, Jobs and Backups go back to: ' + MODULES.map((m) => `${m.label} ${instance.defaults.modules[m.key] ? 'on' : 'off'}`).join(', ') + '.',
        ...off.map((m) => m.whenOff),
      ],
      confirmLabel: 'Reset',
      danger: off.length > 0,
      send: { reset_modules: true },
    })
  }

  return (
    <div className="space-y-4">
      <Card className="divide-y divide-zinc-800">
        {MODULES.map((m) => {
          const on = instance.modules[m.key]
          const locked = !instance.editable || busy
          return (
            <div key={m.key} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="text-zinc-200">{m.label}</div>
                <div className="text-xs text-zinc-400">
                  {m.what}
                  {m.key === 'backups' && on && <> <Link to="/backups" className="text-emerald-400 hover:underline">Open Backups</Link></>}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={m.label}
                disabled={locked}
                onClick={() => ask(m)}
                className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          )
        })}
      </Card>
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-3">
        {saved && <span role="status" className="text-sm text-emerald-400">Saved</span>}
        {instance.editable && anySaved && (
          <Button type="button" variant="ghost" disabled={busy} onClick={askReset}>Reset to defaults</Button>
        )}
        {!instance.editable && <span className="text-sm text-zinc-400">You can't change these.</span>}
      </div>
      {pending && (
        <Modal title={pending.title} onClose={() => !busy && setPending(null)}>
          <div className="space-y-3 text-sm text-zinc-300">
            {pending.body.map((t) => <p key={t}>{t}</p>)}
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
            <Button type="button" variant={pending.danger ? 'danger' : 'primary'} onClick={() => void confirmIt()} disabled={busy}>{busy ? 'Saving…' : pending.confirmLabel}</Button>
          </div>
        </Modal>
      )}
    </div>
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
