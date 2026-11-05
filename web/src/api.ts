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
  backup_enabled: boolean
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
  all_projects: boolean // admins: sees every project that isn't owner-only
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
  owner_only: boolean // hidden from every admin unless the owner shares it with them
  health_status: HealthStatus | 'none'
  check_count: number
  service_count: number
}

/** An optional group inside a project (frontend, backend, worker…). Organization only — not access control. */
export interface Service {
  id: string
  project_id: string
  project_key: string
  key: string
  name: string
  description: string
  repository_url: string | null
  root_directory: string | null
  secret_count: number
  job_count: number
  check_count: number
  failing_jobs: number
  health_status: HealthStatus | 'none'
  created_at: string
  updated_at: string
}

/** Scope fields shared by secrets, jobs and checks. service_* null = the project directly. */
export interface Scoped {
  service_id: string | null
  service_key: string | null
  service_name: string | null
}

/** Service filter of a list: '' = all, '-' = the project directly, otherwise a service ID. */
export type ServiceFilter = string

export type HealthStatus = 'up' | 'degraded' | 'down' | 'unknown'

export interface HealthCheck extends Scoped {
  id: string
  project_id: string
  project_key: string
  project_name: string
  environment_id: string | null
  environment: string | null
  name: string
  url: string
  method: string
  interval_seconds: number
  timeout_seconds: number
  expected_status: string
  max_response_ms: number | null
  ssl_warn_days: number | null
  down_threshold: number
  recovery_threshold: number
  enabled: boolean
  status: HealthStatus
  consecutive_failures: number
  consecutive_successes: number
  status_since: string | null
  last_checked_at: string | null
  last_response_ms: number | null
  last_status_code: number | null
  last_error: string | null
  ssl_expires_at: string | null
  next_check_at: string | null
  uptime_24h: number | null
  created_at: string
  updated_at: string
}

export interface HealthEvent {
  id: number
  at: string
  from_status: HealthStatus
  to_status: HealthStatus
  message: string
}

export interface Uptime {
  '24h': number | null
  '7d': number | null
  '30d': number | null
}

export interface SeriesBucket {
  t: string
  avg_ms: number | null
  max_ms: number | null
  min_ms: number | null
  ok: number
  fail: number
}

export interface Job extends Scoped {
  id: string
  project_id: string
  project_key: string
  project_name: string
  environment_id: string | null
  environment: string | null
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

export interface Secret extends Scoped {
  id: string
  environment_id: string
  environment: string
  project_id: string
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

export interface ApiToken {
  id: string
  kind: 'api' | 'deploy'
  name: string
  prefix: string
  role: 'contributor' | 'viewer'
  created_by: string | null
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  last_used_ip: string | null
  revoked_at: string | null
  status: 'active' | 'expired' | 'revoked'
  // API tokens: every project the creator can see, or only these (keys).
  all_projects: boolean
  allowed_projects: string[]
  // Deploy tokens only: the one place they can read from.
  project: string | null
  project_name: string | null
  service: string | null
  environment: string | null
}

export interface BackupSettings {
  interval_minutes: number
  keep: number
}

export type BackupState = 'ok' | 'stale' | 'failed' | 'none'

export interface BackupStatus {
  enabled: boolean
  dir: string
  settings: BackupSettings
  running: boolean
  state: BackupState
  last_success_at: string | null
  last_attempt_at: string | null
  last_error: string | null
  next_run_at: string | null
  files: number
}

export interface BackupRow {
  id: string
  file_name: string | null
  size_bytes: number | null
  status: 'success' | 'failed'
  error: string | null
  trigger: 'manual' | 'scheduled'
  triggered_by: string | null
  started_at: string
  finished_at: string | null
  on_disk: boolean
}

export interface BackupFile {
  name: string
  size_bytes: number
  created_at: string
}

export type ChannelType = 'telegram' | 'discord' | 'slack' | 'email'

export interface AlertChannel {
  id: string
  type: ChannelType
  name: string
  enabled: boolean
  summary: string
  created_at: string
}

export interface AlertEventState {
  key: string
  label: string
  description: string
  default_enabled: boolean
  has_days: boolean
  enabled: boolean
  days?: number[]
}

export interface AlertRecord {
  id: number
  at: string
  event: string
  channel_name: string
  project_key: string | null
  service_key: string | null
  title: string
  status: 'sent' | 'failed'
  error: string | null
}

export interface Invite {
  id: string
  email: string
  role: Role
  invited_by: string | null
  expires_at: string
  created_at: string
  all_projects: boolean
  projects: string[] // keys of the projects shared with the invitee (only ones you can see)
}

export interface AuditRow {
  id: number
  at: string
  actor: string
  action: string
  target_type: string | null
  target_id: string | null
  ip: string
  details: Record<string, unknown>
}

export const canWrite = (role: Role) => role === 'owner' || role === 'admin' || role === 'contributor'
/** Owner and admin manage projects, their structure and who can see them. */
export const isAdmin = (role: Role) => role === 'owner' || role === 'admin'
