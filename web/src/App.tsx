import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { isAdmin } from './api'
import { useAuth } from './auth'
import { NavIcon, type IconName } from './icons'
import { LoginPage, SetupPage, TwoFactorEnrollPage, TwoFactorVerifyPage } from './pages/auth'
import { CheckDetailPage, CheckFormPage } from './pages/health'
import { JobDetailPage, JobFormPage, JobsPage } from './pages/jobs'
import { DashboardPage } from './pages/dashboard'
import { ProjectDetailPage, ProjectNewPage, ProjectsPage } from './pages/projects'
import { ProfilePage } from './pages/profile'
import { SettingsPage } from './pages/settings'
import { AlertsPage } from './pages/alerts'
import { IntegrationsPage } from './pages/integrations'
import { BackupPill, BackupsPage, useBackupStatus } from './pages/backups'
import { AcceptInvitePage, AuditPage, ResetPasswordPage, UsersPage } from './pages/team'
import { VaultPage } from './pages/vault'
import { cx, Spinner } from './ui'

export default function App() {
  const { loading, meta, user, next } = useAuth()
  const { pathname } = useLocation()

  // Invite and password-reset links work whether or not anyone is logged in.
  if (pathname.startsWith('/invite/') || pathname.startsWith('/reset/')) {
    return (
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
      </Routes>
    )
  }

  if (loading) return <Spinner />
  if (!meta) return <div className="p-8 text-sm text-red-300">Can't reach the Rexus server.</div>

  // Setup mode: no owner yet.
  if (meta.setup_required) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }
  if (next === '2fa_verify') return <TwoFactorVerifyPage />
  if (next === '2fa_enroll') return <TwoFactorEnrollPage />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={isAdmin(user.role) ? <ProjectNewPage /> : <Navigate to="/projects" replace />} />
        <Route path="/projects/:key" element={<ProjectDetailPage />} />
        <Route path="/projects/:key/checks/new" element={<CheckFormPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/checks/new" element={<CheckFormPage />} />
        <Route path="/checks/:id" element={<CheckDetailPage />} />
        <Route path="/checks/:id/edit" element={<CheckFormPage />} />
        {meta.modules.scheduler && (
          <>
            <Route path="/jobs/new" element={<JobFormPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/jobs/:id/edit" element={<JobFormPage />} />
          </>
        )}
        {meta.modules.vault && <Route path="/vault" element={<VaultPage />} />}
        {isAdmin(user.role) && (
          <>
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            {meta.backup_enabled && <Route path="/backups" element={<BackupsPage />} />}
            <Route path="/users" element={<UsersPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </>
        )}
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

interface NavItem {
  to: string
  label: string
  icon: IconName
  end?: boolean
}

function initials(name: string, email: string) {
  const source = name.trim() || email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2)
  return letters.toUpperCase()
}

function SideLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cx(
          'flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium',
          isActive ? 'bg-emerald-500/10 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
        )
      }
    >
      <NavIcon name={item.icon} />
      <span className="truncate">{item.label}</span>
    </NavLink>
  )
}

function Layout() {
  const { meta, user } = useAuth()
  const { pathname } = useLocation()
  const [drawer, setDrawer] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  // The "last backup" indicator is always visible to the owner and admins when backups are on.
  const admin = !!user && isAdmin(user.role)
  const backupStatus = useBackupStatus(admin && !!meta?.backup_enabled)

  const workspace: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
    { to: '/projects', label: 'Projects', icon: 'projects' },
    ...(meta?.modules.vault ? [{ to: '/vault', label: 'Vault', icon: 'vault' as IconName }] : []),
    ...(meta?.modules.scheduler ? [{ to: '/jobs', label: 'Pings', icon: 'pings' as IconName }] : [{ to: '/jobs', label: 'Health', icon: 'pings' as IconName }]),
  ]
  const administration: NavItem[] = admin
    ? [
        { to: '/alerts', label: 'Alerts', icon: 'alerts' },
        { to: '/integrations', label: 'API & integrations', icon: 'api' },
        { to: '/users', label: 'Users', icon: 'users' },
        { to: '/audit', label: 'Audit log', icon: 'audit' },
        ...(meta?.backup_enabled ? [{ to: '/backups', label: 'Backups', icon: 'backups' as IconName }] : []),
      ]
    : []

  // Close the drawer after navigating, and on Escape. Focus moves into it when it opens.
  useEffect(() => setDrawer(false), [pathname])
  useEffect(() => {
    if (!drawer) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2.5 px-4 py-4">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0 truncate text-sm font-semibold text-zinc-50">{meta?.company_name}</div>
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-3">
        <div>
          <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Workspace</div>
          <div className="space-y-0.5">{workspace.map((n) => <SideLink key={n.to} item={n} />)}</div>
        </div>
        {administration.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Administration</div>
            <div className="space-y-0.5">{administration.map((n) => <SideLink key={n.to} item={n} />)}</div>
          </div>
        )}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-zinc-800 px-3 py-3">
        <BackupPill status={backupStatus} />
        {admin && <SideLink item={{ to: '/settings', label: 'Settings', icon: 'settings' }} />}
        <div className="flex items-center gap-1">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              cx('flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2', isActive ? 'bg-emerald-500/10' : 'hover:bg-zinc-900')
            }
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-100">
              {user ? initials(user.name, user.email) : ''}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-100">{user?.name || user?.email}</span>
              <span className="block truncate text-xs capitalize text-zinc-500">{user?.role}</span>
            </span>
          </NavLink>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-zinc-800 bg-zinc-950 md:sticky md:top-0 md:block md:h-screen md:w-60 md:shrink-0">{sidebar}</aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-2.5 md:hidden">
        <button
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          aria-expanded={drawer}
          className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-900"
        >
          <NavIcon name="menu" />
        </button>
        <img src="/favicon.svg" alt="" className="h-6 w-6" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-50">{meta?.company_name}</span>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-zinc-800 bg-zinc-950 shadow-xl">
            <button
              ref={closeRef}
              onClick={() => setDrawer(false)}
              aria-label="Close menu"
              className="absolute right-2 top-3 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            >
              <NavIcon name="close" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
