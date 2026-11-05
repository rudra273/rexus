// Tiny API client. Every state-changing call sends X-Rexus-Request (CSRF guard).

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Rexus-Request'] = '1'
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

// ---- types (mirror the Go API) ----

export type Role = 'owner' | 'admin' | 'contributor' | 'viewer'
export type NextStep = 'ok' | '2fa_verify' | '2fa_enroll'

export interface Meta {
  company_name: string
  version: string
  env: string
  setup_required: boolean
  two_fa_mode: string
  modules: { scheduler: boolean; vault: boolean }
}

export interface User {
  id: string
  email: string
  name: string
  role: Role
  status: string
  totp_enabled: boolean
  last_login_at: string | null
  created_at: string
}

export interface SessionResp {
  user: User
  next: NextStep
}

export interface Project {
  id: string
  key: string
  name: string
  description: string
  created_at: string
  updated_at: string
  job_count: number
  failing_jobs: number
}

export interface Job {
  id: string
  project_id: string | null
  project_key: string | null
  project_name: string | null
  name: string
  type: string
  schedule: string
  config: { url: string; method: string; body?: string; expected_status: string }
  headers?: Record<string, string>
  timeout_seconds: number
  retries: number
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
  last_status: 'success' | 'failed' | null
  created_at: string
  updated_at: string
}

export interface JobRun {
  id: string
  job_id: string
  trigger: 'schedule' | 'manual'
  status: 'running' | 'success' | 'failed'
  attempts: number
  status_code: number | null
  duration_ms: number | null
  error: string | null
  response_snippet: string | null
  started_at: string
  finished_at: string | null
}

export interface Environment {
  id: string
  project_id: string
  name: string
  secret_count: number
  created_at: string
}

export interface Secret {
  id: string
  environment_id: string
  environment: string
  project_key: string
  project_name: string
  name: string
  expires_on: string | null
  days_left: number | null
  notes: string
  tags: string[]
  custom_fields: Record<string, string>
  current_version: number
  created_at: string
  updated_at: string
  updated_by: string | null
}

export interface SecretVersion {
  version: number
  created_by: string | null
  created_at: string
  current: boolean
}

export const canWrite =(role: Role) => role === 'owner' || role === 'admin' || role === 'contributor'
export const isAdmin = (role: Role) => role === 'owner' || role === 'admin'
