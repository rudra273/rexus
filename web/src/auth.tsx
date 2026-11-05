import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, type Meta, type NextStep, type SessionResp, type User } from './api'

interface AuthState {
  loading: boolean
  meta: Meta | null
  user: User | null
  next: NextStep | null
  refresh: () => Promise<void>
  setSession: (s: SessionResp | null) => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [next, setNext] = useState<NextStep | null>(null)

  const refresh = useCallback(async () => {
    try {
      const m = await api<Meta>('/api/meta')
      setMeta(m)
      document.title = m.company_name === 'Rexus' ? 'Rexus' : `${m.company_name} · Rexus`
      if (m.setup_required) {
        setUser(null)
        setNext(null)
        return
      }
      try {
        const s = await api<SessionResp>('/api/auth/me')
        setUser(s.user)
        setNext(s.next)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setUser(null)
          setNext(null)
        } else {
          throw e
        }
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [refresh])

  const setSession = useCallback((s: SessionResp | null) => {
    setUser(s?.user ?? null)
    setNext(s?.next ?? null)
  }, [])

  return (
    <AuthContext.Provider value={{ loading, meta, user, next, refresh, setSession }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
