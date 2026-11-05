import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { api } from './api'
import { useAuth } from './auth'
import { LoginPage, SetupPage, TwoFactorEnrollPage, TwoFactorVerifyPage } from './pages/auth'
import { JobDetailPage, JobFormPage, JobsPage } from './pages/jobs'
import { DashboardPage, ProjectDetailPage, ProjectNewPage } from './pages/projects'
import { SettingsPage } from './pages/settings'
import { VaultPage } from './pages/vault'
import { cx, Spinner } from './ui'

export default function App() {
  const { loading, meta, user, next } = useAuth()

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
        <Route path="/projects/new" element={<ProjectNewPage />} />
        <Route path="/projects/:key" element={<ProjectDetailPage />} />
        {meta.modules.scheduler && (
          <>
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/new" element={<JobFormPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/jobs/:id/edit" element={<JobFormPage />} />
          </>
        )}
        {meta.modules.vault && <Route path="/vault" element={<VaultPage />} />}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function Layout() {
  const { meta, user, setSession } = useAuth()
  const nav = [
    { to: '/', label: 'Dashboard', end: true },
    ...(meta?.modules.vault ? [{ to: '/vault', label: 'Vault', end: false }] : []),
    ...(meta?.modules.scheduler ? [{ to: '/jobs', label: 'Jobs', end: false }] : []),
    { to: '/settings', label: 'Settings', end: false },
  ]

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setSession(null)
  }

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-zinc-800 bg-zinc-950 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-50">{meta?.company_name}</div>
            <div className="text-[11px] text-zinc-500">Rexus</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx('rounded-md px-3 py-2 text-sm whitespace-nowrap', isActive ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200')
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-4 py-4 md:absolute md:bottom-0 md:block md:w-56">
          <div className="truncate text-xs text-zinc-400">{user?.email}</div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="text-[11px] text-zinc-500">{user?.role}</span>
            <button onClick={logout} className="text-xs text-zinc-500 hover:text-zinc-200">Log out</button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
        <div className="mt-10 text-right md:hidden">
          <button onClick={logout} className="text-xs text-zinc-500 hover:text-zinc-200">Log out ({user?.email})</button>
        </div>
      </main>
    </div>
  )
}
