package store

import (
	"context"
	"fmt"
	"time"
)

// Check statuses.
const (
	StatusUnknown  = "unknown"
	StatusUp       = "up"
	StatusDegraded = "degraded"
	StatusDown     = "down"
)

type HealthCheck struct {
	ID                   string     `json:"id"`
	ProjectID            string     `json:"project_id"`
	ProjectKey           string     `json:"project_key"`
	ProjectName          string     `json:"project_name"`
	ServiceID            *string    `json:"service_id"` // nil = belongs to the project directly
	ServiceKey           *string    `json:"service_key"`
	ServiceName          *string    `json:"service_name"`
	EnvironmentID        *string    `json:"environment_id"` // nil = not tied to an environment
	EnvironmentName      *string    `json:"environment"`
	Name                 string     `json:"name"`
	URL                  string     `json:"url"`
	Method               string     `json:"method"`
	IntervalSeconds      int        `json:"interval_seconds"`
	TimeoutSeconds       int        `json:"timeout_seconds"`
	ExpectedStatus       string     `json:"expected_status"`
	MaxResponseMS        *int       `json:"max_response_ms"`
	SSLWarnDays          *int       `json:"ssl_warn_days"`
	DownThreshold        int        `json:"down_threshold"`
	RecoveryThreshold    int        `json:"recovery_threshold"`
	Enabled              bool       `json:"enabled"`
	Status               string     `json:"status"`
	ConsecutiveFailures  int        `json:"consecutive_failures"`
	ConsecutiveSuccesses int        `json:"consecutive_successes"`
	StatusSince          *time.Time `json:"status_since"`
	LastCheckedAt        *time.Time `json:"last_checked_at"`
	LastResponseMS       *int       `json:"last_response_ms"`
	LastStatusCode       *int       `json:"last_status_code"`
	LastError            *string    `json:"last_error"`
	SSLExpiresAt         *time.Time `json:"ssl_expires_at"`
	NextCheckAt          *time.Time `json:"next_check_at"`
	Uptime24h            *float64   `json:"uptime_24h"` // percent, nil until there are results
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

const healthSelect = `SELECT c.id, c.project_id, p.key, p.name, c.service_id, sv.key, sv.name, c.environment_id, e.name,
	c.name, c.url, c.method, c.interval_seconds,
	c.timeout_seconds, c.expected_status, c.max_response_ms, c.ssl_warn_days, c.down_threshold, c.recovery_threshold,
	c.enabled, c.status, c.consecutive_failures, c.consecutive_successes, c.status_since, c.last_checked_at,
	c.last_response_ms, c.last_status_code, c.last_error, c.ssl_expires_at, c.next_check_at,
	(SELECT 100.0 * count(*) FILTER (WHERE r.ok) / NULLIF(count(*), 0)
	   FROM health_results r WHERE r.check_id = c.id AND r.checked_at > now() - interval '24 hours'),
	c.created_at, c.updated_at
	FROM health_checks c JOIN projects p ON p.id = c.project_id
	LEFT JOIN services sv ON sv.id = c.service_id
	LEFT JOIN environments e ON e.id = c.environment_id`

func scanHealth(row interface{ Scan(...any) error }) (*HealthCheck, error) {
	c := &HealthCheck{}
	err := row.Scan(&c.ID, &c.ProjectID, &c.ProjectKey, &c.ProjectName, &c.ServiceID, &c.ServiceKey, &c.ServiceName,
		&c.EnvironmentID, &c.EnvironmentName, &c.Name, &c.URL, &c.Method, &c.IntervalSeconds,
		&c.TimeoutSeconds, &c.ExpectedStatus, &c.MaxResponseMS, &c.SSLWarnDays, &c.DownThreshold, &c.RecoveryThreshold,
		&c.Enabled, &c.Status, &c.ConsecutiveFailures, &c.ConsecutiveSuccesses, &c.StatusSince, &c.LastCheckedAt,
		&c.LastResponseMS, &c.LastStatusCode, &c.LastError, &c.SSLExpiresAt, &c.NextCheckAt, &c.Uptime24h,
		&c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

func (s *Store) listHealth(ctx context.Context, where string, args ...any) ([]*HealthCheck, error) {
	rows, err := s.Pool.Query(ctx, healthSelect+where+` ORDER BY p.name, sv.name NULLS FIRST, c.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*HealthCheck{}
	for rows.Next() {
		c, err := scanHealth(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListHealthChecks(ctx context.Context) ([]*HealthCheck, error) {
	return s.listHealth(ctx, "")
}

func (s *Store) ListProjectChecks(ctx context.Context, projectID string) ([]*HealthCheck, error) {
	return s.listHealth(ctx, ` WHERE c.project_id = $1`, projectID)
}

// CheckFilter narrows ListChecks. Zero values mean "no filter".
type CheckFilter struct {
	ProjectID   string
	Service     ScopeFilter
	Environment ScopeFilter
	Access      Access // which projects the caller may see
}

func (s *Store) ListChecks(ctx context.Context, f CheckFilter) ([]*HealthCheck, error) {
	var b filterBuilder
	if f.ProjectID != "" {
		b.add("c.project_id = ?", f.ProjectID)
	}
	b.scope("c.service_id", f.Service)
	b.scope("c.environment_id", f.Environment)
	b.access("c.project_id", f.Access)
	return s.listHealth(ctx, b.sql(), b.args...)
}

func (s *Store) HealthCheckByID(ctx context.Context, id string) (*HealthCheck, error) {
	return scanHealth(s.Pool.QueryRow(ctx, healthSelect+` WHERE c.id = $1`, id))
}

func (s *Store) CountProjectChecks(ctx context.Context, projectID string) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM health_checks WHERE project_id = $1`, projectID).Scan(&n)
	return n, err
}

// CreateHealthCheck stores a check; its first probe runs right away.
func (s *Store) CreateHealthCheck(ctx context.Context, c *HealthCheck, createdBy string) (*HealthCheck, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO health_checks (project_id, name, url, method, interval_seconds,
			timeout_seconds, expected_status, max_response_ms, ssl_warn_days, down_threshold, recovery_threshold,
			enabled, next_check_at, created_by, service_id, environment_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 THEN now() END, $13, $14, $15)
		RETURNING id`,
		c.ProjectID, c.Name, c.URL, c.Method, c.IntervalSeconds, c.TimeoutSeconds, c.ExpectedStatus, c.MaxResponseMS,
		c.SSLWarnDays, c.DownThreshold, c.RecoveryThreshold, c.Enabled, createdBy, c.ServiceID, c.EnvironmentID).Scan(&id)
	if err != nil {
		return nil, writeErr(err)
	}
	return s.HealthCheckByID(ctx, id)
}

// UpdateHealthCheck saves new settings and schedules an immediate re-check.
// resetState starts the status over (used when the URL changed: old results
// described a different target).
func (s *Store) UpdateHealthCheck(ctx context.Context, c *HealthCheck, resetState bool) (*HealthCheck, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE health_checks SET name = $2, url = $3, method = $4, interval_seconds = $5,
			timeout_seconds = $6, expected_status = $7, max_response_ms = $8, ssl_warn_days = $9,
			down_threshold = $10, recovery_threshold = $11, enabled = $12,
			next_check_at = CASE WHEN $12 THEN now() END,
			status = CASE WHEN $13 THEN 'unknown' ELSE status END,
			consecutive_failures = CASE WHEN $13 THEN 0 ELSE consecutive_failures END,
			consecutive_successes = CASE WHEN $13 THEN 0 ELSE consecutive_successes END,
			status_since = CASE WHEN $13 THEN NULL ELSE status_since END,
			ssl_expires_at = CASE WHEN $13 THEN NULL ELSE ssl_expires_at END,
			service_id = $14, environment_id = $15,
			updated_at = now()
		WHERE id = $1`,
		c.ID, c.Name, c.URL, c.Method, c.IntervalSeconds, c.TimeoutSeconds, c.ExpectedStatus, c.MaxResponseMS,
		c.SSLWarnDays, c.DownThreshold, c.RecoveryThreshold, c.Enabled, resetState, c.ServiceID, c.EnvironmentID)
	if err != nil {
		return nil, writeErr(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.HealthCheckByID(ctx, c.ID)
}

func (s *Store) DeleteHealthCheck(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM health_checks WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClaimDueChecks picks enabled checks that are due and pushes their next run
// forward, so a slow or missed check is probed once and then continues on
// schedule (no pile-up after downtime). SKIP LOCKED keeps two processes from
// probing the same check.
func (s *Store) ClaimDueChecks(ctx context.Context, limit int) ([]*HealthCheck, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, healthSelect+` WHERE c.enabled AND c.next_check_at <= now()
		ORDER BY c.next_check_at LIMIT $1 FOR UPDATE OF c SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	var checks []*HealthCheck
	for rows.Next() {
		c, err := scanHealth(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		checks = append(checks, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range checks {
		if _, err := tx.Exec(ctx, `UPDATE health_checks SET next_check_at = now() + (interval_seconds * interval '1 second')
			WHERE id = $1`, c.ID); err != nil {
			return nil, err
		}
	}
	return checks, tx.Commit(ctx)
}

// HealthResult is the raw outcome of one probe.
type HealthResult struct {
	OK           bool
	StatusCode   *int
	ResponseMS   *int
	Error        *string
	SSLExpiresAt *time.Time
}

// HealthTransition is the new state computed from a result.
type HealthTransition struct {
	Status    string
	Failures  int
	Successes int
	Message   string // explains a status change (shown in events and alerts)
	Reason    string // why a check is degraded: "slow" or "ssl"
}

// HealthChange describes a status change that RecordHealth just stored.
type HealthChange struct {
	From, To string
	Message  string
	Reason   string
	// Since is when the previous status began (e.g. when a down check went down).
	Since *time.Time
	// Check is the check as it was before this probe.
	Check *HealthCheck
}

// RecordHealth stores a probe result and updates the check's status. The
// check row is locked while eval runs, so overlapping probes (scheduled +
// "run now") can't corrupt the failure counters. It returns what changed, or
// nil if the status stayed the same.
func (s *Store) RecordHealth(ctx context.Context, checkID string, r HealthResult, eval func(*HealthCheck) HealthTransition) (*HealthChange, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	c, err := scanHealth(tx.QueryRow(ctx, healthSelect+` WHERE c.id = $1 FOR UPDATE OF c`, checkID))
	if err != nil {
		return nil, err // ErrNotFound if the check was deleted mid-probe
	}
	t := eval(c)

	if _, err := tx.Exec(ctx, `INSERT INTO health_results (check_id, ok, status_code, response_ms, error)
		VALUES ($1, $2, $3, $4, $5)`, checkID, r.OK, r.StatusCode, r.ResponseMS, r.Error); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE health_checks SET status = $2, consecutive_failures = $3, consecutive_successes = $4,
			status_since = CASE WHEN status <> $2 OR status_since IS NULL THEN now() ELSE status_since END,
			last_checked_at = now(), last_response_ms = $5, last_status_code = $6, last_error = $7,
			ssl_expires_at = COALESCE($8, ssl_expires_at)
		WHERE id = $1`,
		checkID, t.Status, t.Failures, t.Successes, r.ResponseMS, r.StatusCode, r.Error, r.SSLExpiresAt); err != nil {
		return nil, err
	}
	var change *HealthChange
	if t.Status != c.Status {
		change = &HealthChange{From: c.Status, To: t.Status, Message: t.Message, Reason: t.Reason, Since: c.StatusSince, Check: c}
		// The very first unknown → up isn't an incident; everything else is.
		if !(c.Status == StatusUnknown && t.Status == StatusUp) {
			if _, err := tx.Exec(ctx, `INSERT INTO health_events (check_id, from_status, to_status, message, reason)
				VALUES ($1, $2, $3, $4, $5)`, checkID, c.Status, t.Status, t.Message, t.Reason); err != nil {
				return nil, err
			}
		}
	}
	return change, tx.Commit(ctx)
}

// ---- events, series, uptime, pruning ----

type HealthEvent struct {
	ID         int64     `json:"id"`
	At         time.Time `json:"at"`
	FromStatus string    `json:"from_status"`
	ToStatus   string    `json:"to_status"`
	Message    string    `json:"message"`
}

func (s *Store) ListHealthEvents(ctx context.Context, checkID string, limit int) ([]*HealthEvent, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, at, from_status, to_status, message FROM health_events
		WHERE check_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, checkID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*HealthEvent{}
	for rows.Next() {
		e := &HealthEvent{}
		if err := rows.Scan(&e.ID, &e.At, &e.FromStatus, &e.ToStatus, &e.Message); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecentHealthEvent is a status change together with the check it belongs to, for the dashboard timeline.
type RecentHealthEvent struct {
	HealthEvent
	CheckID     string `json:"check_id"`
	CheckName   string `json:"check_name"`
	ProjectKey  string `json:"project_key"`
	ProjectName string `json:"project_name"`
}

// ListRecentHealthEvents returns status changes of every check the caller can see, newest first.
func (s *Store) ListRecentHealthEvents(ctx context.Context, a Access, window time.Duration, limit int) ([]*RecentHealthEvent, error) {
	var b filterBuilder
	b.add("e.at > now() - make_interval(secs => ?::float8)", window.Seconds())
	b.access("c.project_id", a)
	args := append(b.args, limit)
	rows, err := s.Pool.Query(ctx, fmt.Sprintf(`SELECT e.id, e.at, e.from_status, e.to_status, e.message,
			c.id, c.name, p.key, p.name
		FROM health_events e
		JOIN health_checks c ON c.id = e.check_id
		JOIN projects p ON p.id = c.project_id`+b.sql()+`
		ORDER BY e.at DESC, e.id DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*RecentHealthEvent{}
	for rows.Next() {
		e := &RecentHealthEvent{}
		if err := rows.Scan(&e.ID, &e.At, &e.FromStatus, &e.ToStatus, &e.Message, &e.CheckID, &e.CheckName, &e.ProjectKey, &e.ProjectName); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type HealthUptime struct {
	Day   *float64 `json:"24h"`
	Week  *float64 `json:"7d"`
	Month *float64 `json:"30d"`
}

func (s *Store) CheckUptime(ctx context.Context, checkID string) (*HealthUptime, error) {
	u := &HealthUptime{}
	err := s.Pool.QueryRow(ctx, `SELECT
		100.0 * count(*) FILTER (WHERE ok AND checked_at > now() - interval '24 hours')
			/ NULLIF(count(*) FILTER (WHERE checked_at > now() - interval '24 hours'), 0),
		100.0 * count(*) FILTER (WHERE ok AND checked_at > now() - interval '7 days')
			/ NULLIF(count(*) FILTER (WHERE checked_at > now() - interval '7 days'), 0),
		100.0 * count(*) FILTER (WHERE ok) / NULLIF(count(*), 0)
		FROM health_results WHERE check_id = $1 AND checked_at > now() - interval '30 days'`, checkID).
		Scan(&u.Day, &u.Week, &u.Month)
	return u, err
}

// SeriesBucket is a slice of time with the probes that fell into it.
type SeriesBucket struct {
	T     time.Time `json:"t"`
	AvgMS *float64  `json:"avg_ms"`
	MaxMS *int      `json:"max_ms"`
	MinMS *int      `json:"min_ms"`
	OK    int       `json:"ok"`
	Fail  int       `json:"fail"`
}

// CheckSeries returns results over the last `window`, grouped into buckets of
// `bucket` so a 30-day chart stays a few hundred points.
func (s *Store) CheckSeries(ctx context.Context, checkID string, window, bucket time.Duration) ([]*SeriesBucket, error) {
	rows, err := s.Pool.Query(ctx, `SELECT
			to_timestamp(floor(extract(epoch FROM checked_at) / $2::float8) * $2::float8) AS t,
			avg(response_ms)::float8, max(response_ms), min(response_ms),
			count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok)
		FROM health_results
		WHERE check_id = $1 AND checked_at > now() - make_interval(secs => $3::float8)
		GROUP BY 1 ORDER BY 1`, checkID, bucket.Seconds(), window.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*SeriesBucket{}
	for rows.Next() {
		b := &SeriesBucket{}
		if err := rows.Scan(&b.T, &b.AvgMS, &b.MaxMS, &b.MinMS, &b.OK, &b.Fail); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// AllChecksSeries is CheckSeries for every check the viewer can see, keyed by check ID
// (for the dashboard). Checks with no results in the window are absent.
func (s *Store) AllChecksSeries(ctx context.Context, a Access, window, bucket time.Duration) (map[string][]*SeriesBucket, error) {
	var b filterBuilder
	b.add("r.checked_at > now() - make_interval(secs => ?::float8)", window.Seconds())
	b.access("c.project_id", a)
	args := append(b.args, bucket.Seconds())
	n := len(args)
	rows, err := s.Pool.Query(ctx, fmt.Sprintf(`SELECT r.check_id,
			to_timestamp(floor(extract(epoch FROM r.checked_at) / $%[1]d::float8) * $%[1]d::float8) AS t,
			avg(r.response_ms)::float8, max(r.response_ms), min(r.response_ms),
			count(*) FILTER (WHERE r.ok), count(*) FILTER (WHERE NOT r.ok)
		FROM health_results r JOIN health_checks c ON c.id = r.check_id`+b.sql()+`
		GROUP BY 1, 2 ORDER BY 1, 2`, n), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]*SeriesBucket{}
	for rows.Next() {
		var id string
		bk := &SeriesBucket{}
		if err := rows.Scan(&id, &bk.T, &bk.AvgMS, &bk.MaxMS, &bk.MinMS, &bk.OK, &bk.Fail); err != nil {
			return nil, err
		}
		out[id] = append(out[id], bk)
	}
	return out, rows.Err()
}

func (s *Store) PruneHealthResults(ctx context.Context, olderThan time.Duration) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM health_results WHERE checked_at < $1`, time.Now().Add(-olderThan))
	return err
}

// SetCheckEnabled pauses or resumes one check. Resuming schedules it for an immediate probe.
func (s *Store) SetCheckEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE health_checks SET enabled = $2,
			next_check_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE id = $1`, id, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetProjectChecksEnabled pauses or resumes every check of a project and returns how many changed.
func (s *Store) SetProjectChecksEnabled(ctx context.Context, projectID string, enabled bool) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE health_checks SET enabled = $2,
			next_check_at = CASE WHEN $2 THEN now() END, updated_at = now()
		WHERE project_id = $1 AND enabled <> $2`, projectID, enabled)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
