import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { Badge, Card, ErrorBox, PageHeader, Spinner, Tabs } from '../ui'

interface InstanceSettings {
  company_name: string
  base_url: string
  version: string
  toggles: Record<string, string>
  smtp?: { configured: boolean; host: string }
}

type Tab = 'general' | 'modules' | 'security' | 'notifications' | 'backups'

/**
 * App-wide configuration. Today every one of these values is set on the server (env vars, see
 * plan.md §3), so this page shows them read-only and says so. Personal settings live in Profile.
 */
export function SettingsPage() {
  const { meta } = useAuth()
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
        <ManagedNote />

        {tab === 'general' && (
          <Card className="divide-y divide-zinc-800">
            <Row label="Company name" help="REXUS_COMPANY_NAME" value={instance.company_name} />
            <Row label="Public URL" help="REXUS_BASE_URL" value={<span className="mono">{instance.base_url}</span>} />
            <Row label="Environment" help="REXUS_ENV" value={val('REXUS_ENV')} />
            <Row label="Version" value={<span className="mono">{instance.version}</span>} managed={false} />
          </Card>
        )}

        {tab === 'modules' && (
          <Card className="divide-y divide-zinc-800">
            <Row label="Vault" help="REXUS_MODULE_VAULT" value={<OnOff on={meta.modules.vault} />} />
            <Row label="Jobs (scheduler)" help="REXUS_MODULE_SCHEDULER" value={<OnOff on={meta.modules.scheduler} />} />
            <Row label="Backups" help="REXUS_BACKUP_ENABLED" value={<OnOff on={meta.backup_enabled} />} />
          </Card>
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
            <Row label="Backups" help="REXUS_BACKUP_ENABLED" value={<OnOff on={meta.backup_enabled} />} />
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <div className="text-zinc-200">Schedule, retention and history</div>
                <div className="text-xs text-zinc-500">
                  {meta.backup_enabled ? 'Edited on the Backups page, which is the one place for these settings.' : 'Turn backups on in .env (REXUS_BACKUP_ENABLED and REXUS_BACKUP_DIR), then restart Rexus.'}
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
