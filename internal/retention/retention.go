// Package retention keeps the database small by deleting history nobody needs any more.
//
// It cleans logs and history only: job runs, health results and events, the alert log, the audit log,
// old versions of secrets, and used-up invites, reset links and sessions. It never touches accounts,
// projects, services, environments, secrets and their current value, tokens, job or health-check
// definitions, alert channels or settings.
//
// How long to keep each kind is a policy the owner sets in Settings → Data. The three categories that
// were never cleaned before (the audit log, old secret versions, health events) stay untouched until the
// owner has saved the policy once, so upgrading never deletes anything nobody has looked at.
package retention

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"rexus/internal/store"
)

const (
	settingKey     = "retention"
	stateKey       = "retention.job"
	JobKey         = "data-cleanup" // its name among the built-in jobs
	JobInterval    = 7 * 24 * time.Hour
	checkEvery     = 10 * time.Minute // how often Rexus looks whether the weekly run is due
	firstCheck     = time.Minute
	keepRunLogs    = 100
	runKeepPerJob  = 20                   // a job always keeps its newest runs, however old
	invitesDays    = 30                   // used or expired invites and reset links
	sessionsDays   = 7                    // expired or revoked sessions
	reminderMemory = 400 * 24 * time.Hour // reminders must be remembered until the expiry they were for (up to 365 days)
)

// Policy is how long each kind of history is kept. Zero means "forever" where that is allowed.
type Policy struct {
	JobRunDays         int `json:"job_run_days"`         // 7–90
	HealthResultDays   int `json:"health_result_days"`   // 7–90
	HealthEventDays    int `json:"health_event_days"`    // 30–365
	AlertLogDays       int `json:"alert_log_days"`       // 30–365
	AuditDays          int `json:"audit_days"`           // 0 (forever) or 90–3650
	SecretVersionsKeep int `json:"secret_versions_keep"` // 0 (all) or 3–50, per secret

	// Confirmed is set once the owner has saved the policy. Until then the categories marked Gated are skipped.
	Confirmed bool `json:"confirmed"`
}

// Defaults is the policy that applies until the owner changes it.
func Defaults() Policy {
	return Policy{JobRunDays: 30, HealthResultDays: 30, HealthEventDays: 180, AlertLogDays: 90, AuditDays: 365, SecretVersionsKeep: 10}
}

// InvalidError is a policy value out of range.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

func within(name string, v, lo, hi int, zeroOK bool) error {
	if zeroOK && v == 0 {
		return nil
	}
	if v < lo || v > hi {
		zero := ""
		if zeroOK {
			zero = " (or 0 for no limit)"
		}
		return &InvalidError{fmt.Sprintf("%s must be between %d and %d%s", name, lo, hi, zero)}
	}
	return nil
}

// Validate checks every value is in its allowed range.
func (p Policy) Validate() error {
	for _, c := range []error{
		within("job run history (days)", p.JobRunDays, 7, 90, false),
		within("health check results (days)", p.HealthResultDays, 7, 90, false),
		within("health status changes (days)", p.HealthEventDays, 30, 365, false),
		within("alert log (days)", p.AlertLogDays, 30, 365, false),
		within("audit log (days)", p.AuditDays, 90, 3650, true),
		within("secret versions kept", p.SecretVersionsKeep, 3, 50, true),
	} {
		if c != nil {
			return c
		}
	}
	return nil
}

// Category is one kind of history and the rows that are past their time under a policy.
type Category struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Rule  string `json:"rule"`  // what is deleted, in words
	Gated bool   `json:"gated"` // skipped by automatic cleanup until the policy is confirmed
	// Spec is nil when the category is switched off ("keep forever").
	Spec *store.PruneSpec `json:"-"`
}

func days(n int) time.Time { return time.Now().Add(-time.Duration(n) * 24 * time.Hour) }

// Categories lists what the policy cleans, in the order the page shows them.
func Categories(p Policy) []Category {
	runs := Category{Key: "job_runs", Label: "Job run history",
		Rule: fmt.Sprintf("Runs older than %d days (each job always keeps its last %d runs)", p.JobRunDays, runKeepPerJob),
		Spec: &store.PruneSpec{Table: "job_runs", Args: []any{days(p.JobRunDays), runKeepPerJob},
			Where: `t.started_at < $1 AND t.status <> 'running' AND t.started_at < (
				SELECT r.started_at FROM job_runs r WHERE r.job_id = t.job_id
				ORDER BY r.started_at DESC OFFSET ($2::int - 1) LIMIT 1)`}}
	results := Category{Key: "health_results", Label: "Health check results",
		Rule: fmt.Sprintf("Probe results older than %d days", p.HealthResultDays),
		Spec: &store.PruneSpec{Table: "health_results", Args: []any{days(p.HealthResultDays)}, Where: `t.checked_at < $1`}}
	events := Category{Key: "health_events", Label: "Health status changes", Gated: true,
		Rule: fmt.Sprintf("Up/down changes older than %d days", p.HealthEventDays),
		Spec: &store.PruneSpec{Table: "health_events", Args: []any{days(p.HealthEventDays)}, Where: `t.at < $1`}}
	alertLog := Category{Key: "alerts_sent", Label: "Alert log",
		Rule: fmt.Sprintf("Sent alerts older than %d days (expiry reminders are remembered until the expiry has passed)", p.AlertLogDays),
		Spec: &store.PruneSpec{Table: "alerts_sent", Args: []any{days(p.AlertLogDays), time.Now().Add(-reminderMemory)},
			Where: `(t.dedupe_key IS NULL AND t.at < $1) OR (t.dedupe_key IS NOT NULL AND t.at < LEAST($1::timestamptz, $2::timestamptz))`}}
	audit := Category{Key: "audit_log", Label: "Audit log", Gated: true, Rule: "Kept forever"}
	if p.AuditDays > 0 {
		audit.Rule = fmt.Sprintf("Entries older than %d days", p.AuditDays)
		audit.Spec = &store.PruneSpec{Table: "audit_log", Args: []any{days(p.AuditDays)}, Where: `t.at < $1`}
	}
	versions := Category{Key: "secret_versions", Label: "Old secret versions", Gated: true, Rule: "All versions kept"}
	if p.SecretVersionsKeep > 0 {
		versions.Rule = fmt.Sprintf("Only the newest %d versions of each secret (the current value is never removed)", p.SecretVersionsKeep)
		versions.Spec = &store.PruneSpec{Table: "secret_versions", Args: []any{p.SecretVersionsKeep},
			Where: `t.version <= (SELECT s.current_version FROM secrets s WHERE s.id = t.secret_id) - $1::int`}
	}
	invites := Category{Key: "invites", Label: "Used or expired invites",
		Rule: fmt.Sprintf("Older than %d days", invitesDays),
		Spec: &store.PruneSpec{Table: "invites", Args: []any{days(invitesDays)}, Where: `COALESCE(t.used_at, t.expires_at) < $1`}}
	resets := Category{Key: "password_resets", Label: "Used or expired reset links",
		Rule: fmt.Sprintf("Older than %d days", invitesDays),
		Spec: &store.PruneSpec{Table: "password_resets", Args: []any{days(invitesDays)}, Where: `COALESCE(t.used_at, t.expires_at) < $1`}}
	sessions := Category{Key: "sessions", Label: "Expired sign-ins",
		Rule: fmt.Sprintf("Expired or signed out more than %d days ago", sessionsDays),
		Spec: &store.PruneSpec{Table: "sessions", Args: []any{days(sessionsDays)}, Where: `t.expires_at < $1 OR t.revoked_at < $1`}}
	return []Category{runs, results, events, alertLog, audit, versions, invites, resets, sessions}
}

// storageTables are shown on the page with their size.
var storageTables = []string{"job_runs", "health_results", "health_events", "alerts_sent", "audit_log",
	"secret_versions", "secrets", "invites", "password_resets", "sessions", "backups"}

// JobState is the schedule of the weekly cleanup, kept in the settings table.
type JobState struct {
	Enabled   bool       `json:"enabled"`
	NextRunAt *time.Time `json:"next_run_at"`
}

// Result is what one cleanup run did.
type Result struct {
	Deleted map[string]int64
	Error   string
}

// ErrBusy means a cleanup is already running.
var ErrBusy = errors.New("a cleanup is already running")

// Service reads and saves the policy and runs the cleanup.
type Service struct {
	st  *store.Store
	log *slog.Logger
	mu  sync.Mutex // one cleanup at a time
}

func New(st *store.Store, log *slog.Logger) *Service { return &Service{st: st, log: log} }

// Policy returns the saved policy, or the defaults. A value saved earlier that is out of range falls back to its default.
func (s *Service) Policy(ctx context.Context) (Policy, error) {
	p := Defaults()
	if _, err := s.st.GetSetting(ctx, settingKey, &p); err != nil {
		return Defaults(), err
	}
	if p.Validate() != nil {
		confirmed := p.Confirmed
		p = Defaults()
		p.Confirmed = confirmed
	}
	return p, nil
}

// Save validates and stores a policy and marks it confirmed.
func (s *Service) Save(ctx context.Context, p Policy) (Policy, error) {
	if err := p.Validate(); err != nil {
		return Policy{}, err
	}
	p.Confirmed = true
	return p, s.st.SetSetting(ctx, settingKey, p)
}

// CategoryCount is how many rows of a category are past their time.
type CategoryCount struct {
	Category
	Eligible int64 `json:"eligible"`
	Active   bool  `json:"active"` // false = automatic cleanup skips it (kept forever, or not confirmed yet)
}

// Count reports, for each category, how many rows the policy would delete now. Nothing is deleted.
func (s *Service) Count(ctx context.Context, p Policy) ([]CategoryCount, error) {
	cats := Categories(p)
	out := make([]CategoryCount, 0, len(cats))
	for _, c := range cats {
		cc := CategoryCount{Category: c, Active: c.Spec != nil && (!c.Gated || p.Confirmed)}
		if c.Spec != nil {
			n, err := s.st.CountRows(ctx, *c.Spec)
			if err != nil {
				return nil, fmt.Errorf("count %s: %w", c.Key, err)
			}
			cc.Eligible = n
		}
		out = append(out, cc)
	}
	return out, nil
}

// Overview is everything the Settings → Data page shows.
type Overview struct {
	Policy     Policy             `json:"policy"`
	Defaults   Policy             `json:"defaults"`
	Categories []CategoryCount    `json:"categories"`
	DBBytes    int64              `json:"db_bytes"`
	Tables     []store.TableUsage `json:"tables"`
	Fixed      map[string]int     `json:"fixed"`
}

func (s *Service) Overview(ctx context.Context) (*Overview, error) {
	p, err := s.Policy(ctx)
	if err != nil {
		return nil, err
	}
	cats, err := s.Count(ctx, p)
	if err != nil {
		return nil, err
	}
	total, tables, err := s.st.StorageUsage(ctx, storageTables)
	if err != nil {
		return nil, err
	}
	return &Overview{Policy: p, Defaults: Defaults(), Categories: cats, DBBytes: total, Tables: tables,
		Fixed: map[string]int{"job_runs_kept_per_job": runKeepPerJob, "invite_days": invitesDays, "session_days": sessionsDays}}, nil
}

// ---- the weekly job ----

func (s *Service) state(ctx context.Context) (JobState, error) {
	st := JobState{Enabled: true}
	if _, err := s.st.GetSetting(ctx, stateKey, &st); err != nil {
		return st, err
	}
	return st, nil
}

func (s *Service) saveState(ctx context.Context, st JobState) error {
	return s.st.SetSetting(ctx, stateKey, st)
}

// JobView is the cleanup as the Jobs page shows it.
type JobView struct {
	Key         string           `json:"key"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Schedule    string           `json:"schedule"`
	Enabled     bool             `json:"enabled"`
	NextRunAt   *time.Time       `json:"next_run_at"`
	LastRun     *store.SystemRun `json:"last_run"`
}

func (s *Service) Job(ctx context.Context) (*JobView, error) {
	st, err := s.state(ctx)
	if err != nil {
		return nil, err
	}
	runs, err := s.st.ListSystemRuns(ctx, JobKey, 1)
	if err != nil {
		return nil, err
	}
	v := &JobView{Key: JobKey, Name: "Data cleanup", Schedule: "Every 7 days", Enabled: st.Enabled,
		Description: "Deletes old history (job runs, health results, alert and audit logs, old secret versions) past the times set in Settings → Data."}
	if st.Enabled {
		v.NextRunAt = st.NextRunAt
	}
	if len(runs) > 0 {
		v.LastRun = runs[0]
	}
	return v, nil
}

// Runs returns the log of the latest runs, newest first.
func (s *Service) Runs(ctx context.Context, limit int) ([]*store.SystemRun, error) {
	return s.st.ListSystemRuns(ctx, JobKey, limit)
}

// SetEnabled stops or resumes the weekly run. Resuming schedules the next run a week from now.
func (s *Service) SetEnabled(ctx context.Context, on bool) error {
	st, err := s.state(ctx)
	if err != nil {
		return err
	}
	if on && !st.Enabled {
		next := time.Now().Add(JobInterval)
		st.NextRunAt = &next
	}
	st.Enabled = on
	return s.saveState(ctx, st)
}

// begin records a run that is about to start. The caller holds mu.
func (s *Service) begin(ctx context.Context, trigger string, userID *string) (int64, error) {
	return s.st.StartSystemRun(ctx, JobKey, trigger, userID)
}

// execute does the cleanup for a run begun with begin, records the outcome and schedules the next run. The caller
// holds mu.
func (s *Service) execute(ctx context.Context, runID int64, trigger string) (*Result, error) {
	began := time.Now()
	res := &Result{Deleted: map[string]int64{}}
	var firstErr error
	p, err := s.Policy(ctx)
	if err != nil {
		firstErr = err
	} else {
		for _, c := range Categories(p) {
			if c.Spec == nil || (c.Gated && !p.Confirmed) {
				continue
			}
			n, err := s.st.PruneRows(ctx, *c.Spec)
			if n > 0 {
				res.Deleted[c.Key] = n
			}
			if err != nil {
				s.log.Error("retention: cleanup failed", "category", c.Key, "err", err)
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", c.Key, err)
				}
			}
		}
	}

	// Record the outcome and the next run even if the run was cancelled.
	bg := context.WithoutCancel(ctx)
	status, errMsg := "success", (*string)(nil)
	if firstErr != nil {
		status = "failed"
		m := firstErr.Error()
		errMsg, res.Error = &m, m
	}
	deleted := make(map[string]any, len(res.Deleted))
	for k, v := range res.Deleted {
		deleted[k] = v
	}
	if err := s.st.FinishSystemRun(bg, runID, status, int(time.Since(began).Milliseconds()), map[string]any{"deleted": deleted}, errMsg); err != nil {
		s.log.Warn("retention: save run log", "err", err)
	}
	if st, err := s.state(bg); err == nil {
		next := time.Now().Add(JobInterval)
		st.NextRunAt = &next
		if err := s.saveState(bg, st); err != nil {
			s.log.Warn("retention: save schedule", "err", err)
		}
	}
	if err := s.st.PruneSystemRuns(bg, JobKey, keepRunLogs); err != nil {
		s.log.Warn("retention: prune run log", "err", err)
	}
	// Removing audit entries, secret versions or health events by the schedule is itself recorded, so it can't happen unnoticed.
	if trigger == "schedule" && (res.Deleted["audit_log"] > 0 || res.Deleted["secret_versions"] > 0 || res.Deleted["health_events"] > 0) {
		s.st.Audit(bg, store.AuditEntry{Actor: "system", Action: "retention.run", TargetType: "retention",
			Details: map[string]any{"deleted": deleted}})
	}
	return res, firstErr
}

// Run does a cleanup and waits for it. trigger is "schedule" or "manual".
func (s *Service) Run(ctx context.Context, trigger string, userID *string) (*Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := s.begin(ctx, trigger, userID)
	if err != nil {
		return nil, err
	}
	return s.execute(ctx, id, trigger)
}

// RunAsync starts a manual cleanup in the background and returns at once; the outcome shows in the run log.
func (s *Service) RunAsync(ctx context.Context, userID string) error {
	if !s.mu.TryLock() {
		return ErrBusy
	}
	id, err := s.begin(ctx, "manual", &userID)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	go func() {
		defer s.mu.Unlock()
		_, _ = s.execute(context.Background(), id, "manual")
	}()
	return nil
}

// due runs the weekly cleanup if its time has come.
func (s *Service) due(ctx context.Context) {
	st, err := s.state(ctx)
	if err != nil || !st.Enabled {
		return
	}
	if st.NextRunAt == nil { // first start after the feature arrived: the first run is a week away
		next := time.Now().Add(JobInterval)
		st.NextRunAt = &next
		_ = s.saveState(ctx, st)
		return
	}
	if time.Now().Before(*st.NextRunAt) {
		return
	}
	if res, err := s.Run(ctx, "schedule", nil); err == nil && len(res.Deleted) > 0 {
		s.log.Info("retention: cleaned up", "deleted", res.Deleted)
	}
}

// Start checks every few minutes whether the weekly cleanup is due, until ctx ends.
func (s *Service) Start(ctx context.Context) {
	if err := s.st.FailStaleSystemRuns(ctx); err != nil {
		s.log.Warn("retention: fail stale runs", "err", err)
	}
	go func() {
		t := time.NewTimer(firstCheck)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.due(ctx)
				t.Reset(checkEvery)
			}
		}
	}()
}
