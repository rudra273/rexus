package server

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"rexus/internal/store"
)

// The public API (/api/v1) is for other tools: a CRM, CI, a status board.
// It needs an API token, is read-only, and only ever returns what a viewer
// could see — except that a *contributor* token may also read secret values
// (every such read is audited). Tokens can never be admin or owner.

// ---- what the API returns ----

type projectV1 struct {
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Status      string    `json:"status"` // up | degraded | down | unknown | none
	CheckCount  int       `json:"check_count"`
	JobCount    int       `json:"job_count"`
	FailingJobs int       `json:"failing_jobs"`
	Services    int       `json:"service_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func toProjectV1(p *store.Project) projectV1 {
	return projectV1{Key: p.Key, Name: p.Name, Description: p.Description, Status: p.HealthStatus, CheckCount: p.CheckCount,
		JobCount: p.JobCount, FailingJobs: p.FailingJobs, Services: p.ServiceCount, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

type checkV1 struct {
	ID              string     `json:"id"`
	Service         *string    `json:"service"`     // service key; null = the project directly
	Environment     *string    `json:"environment"` // null = not tied to an environment
	Name            string     `json:"name"`
	URL             string     `json:"url"`
	Method          string     `json:"method"`
	Enabled         bool       `json:"enabled"`
	Status          string     `json:"status"`
	StatusSince     *time.Time `json:"status_since"`
	IntervalSeconds int        `json:"interval_seconds"`
	LastCheckedAt   *time.Time `json:"last_checked_at"`
	LastResponseMS  *int       `json:"last_response_ms"`
	LastStatusCode  *int       `json:"last_status_code"`
	LastError       *string    `json:"last_error"`
	Uptime24h       *float64   `json:"uptime_24h"` // percent
	SSLExpiresAt    *time.Time `json:"ssl_expires_at"`
}

// redactURL drops credentials, the query string and the fragment: a monitored
// URL can carry a token in its query, and that must never leave through the API.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User, u.RawQuery, u.Fragment = nil, "", ""
	return u.String()
}

func toCheckV1(c *store.HealthCheck) checkV1 {
	return checkV1{ID: c.ID, Service: c.ServiceKey, Environment: c.EnvironmentName, Name: c.Name, URL: redactURL(c.URL), Method: c.Method, Enabled: c.Enabled, Status: c.Status,
		StatusSince: c.StatusSince, IntervalSeconds: c.IntervalSeconds, LastCheckedAt: c.LastCheckedAt,
		LastResponseMS: c.LastResponseMS, LastStatusCode: c.LastStatusCode, LastError: c.LastError,
		Uptime24h: c.Uptime24h, SSLExpiresAt: c.SSLExpiresAt}
}

// Jobs deliberately omit their URL, headers and body — they can hold credentials.
type jobV1 struct {
	ID          string     `json:"id"`
	Service     *string    `json:"service"`     // service key; null = the project directly
	Environment *string    `json:"environment"` // null = not tied to an environment
	Name        string     `json:"name"`
	Schedule    string     `json:"schedule"`
	Enabled     bool       `json:"enabled"`
	LastStatus  *string    `json:"last_status"` // success | failed | null
	LastRunAt   *time.Time `json:"last_run_at"`
	NextRunAt   *time.Time `json:"next_run_at"`
}

func toJobV1(j *store.Job) jobV1 {
	return jobV1{ID: j.ID, Service: j.ServiceKey, Environment: j.EnvironmentName, Name: j.Name, Schedule: j.Schedule, Enabled: j.Enabled, LastStatus: j.LastStatus,
		LastRunAt: j.LastRunAt, NextRunAt: j.NextRunAt}
}

// Secrets: names, environment, expiry — never the value. Notes and custom
// fields only for contributor tokens (a viewer can't see them in the UI either).
type secretV1 struct {
	ID           string            `json:"id"`
	Project      string            `json:"project"`
	Service      *string           `json:"service"` // service key; null = the project directly
	Environment  string            `json:"environment"`
	Name         string            `json:"name"`
	Tags         []string          `json:"tags"`
	ExpiresOn    *string           `json:"expires_on"`
	DaysLeft     *int              `json:"days_left"` // negative = already expired
	Version      int               `json:"version"`
	UpdatedAt    time.Time         `json:"updated_at"`
	Notes        *string           `json:"notes,omitempty"`
	CustomFields map[string]string `json:"custom_fields,omitempty"`
}

func toSecretV1(x *store.Secret, t *store.APIToken) secretV1 {
	v := secretV1{ID: x.ID, Project: x.ProjectKey, Service: x.ServiceKey, Environment: x.EnvironmentName, Name: x.Name, Tags: x.Tags,
		ExpiresOn: x.ExpiresOn, DaysLeft: x.DaysLeft, Version: x.CurrentVersion, UpdatedAt: x.UpdatedAt}
	if t.Role == "contributor" {
		v.Notes, v.CustomFields = &x.Notes, x.CustomFields
	}
	return v
}

type serviceV1 struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Description   string  `json:"description"`
	RepositoryURL *string `json:"repository_url"`
	RootDirectory *string `json:"root_directory"`
	Status        string  `json:"status"` // over this service's enabled checks: up | degraded | down | unknown | none
	CheckCount    int     `json:"check_count"`
	JobCount      int     `json:"job_count"`
	FailingJobs   int     `json:"failing_jobs"`
	SecretCount   int     `json:"secret_count"`
}

func toServiceV1(x *store.Service) serviceV1 {
	return serviceV1{Key: x.Key, Name: x.Name, Description: x.Description, RepositoryURL: x.RepositoryURL,
		RootDirectory: x.RootDirectory, Status: x.HealthStatus, CheckCount: x.CheckCount, JobCount: x.JobCount,
		FailingJobs: x.FailingJobs, SecretCount: x.SecretCount}
}

// ---- helpers ----

// v1Scope reads the optional ?service=<key> and ?environment=<name> filters
// (both accept "-" for "none"; leaving one out means "all").
func (s *Server) v1Scope(w http.ResponseWriter, r *http.Request, p *store.Project) (svc, env store.ScopeFilter, ok bool) {
	q := r.URL.Query()
	if k := strings.TrimSpace(q.Get("service")); k == "-" {
		svc = store.ScopeNone
	} else if k != "" {
		x, err := s.store.ServiceByKey(r.Context(), p.ID, k)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "service not found in this project")
			return "", "", false
		}
		if err != nil {
			s.internalError(w, r, err)
			return "", "", false
		}
		svc = store.ScopeFilter(x.ID)
	}
	if n := strings.TrimSpace(q.Get("environment")); n == "-" {
		env = store.ScopeNone
	} else if n != "" {
		envs, err := s.store.ListEnvironments(r.Context(), p.ID)
		if err != nil {
			s.internalError(w, r, err)
			return "", "", false
		}
		for _, e := range envs {
			if e.Name == strings.ToLower(n) {
				env = store.ScopeFilter(e.ID)
			}
		}
		if env == "" {
			writeError(w, http.StatusNotFound, "environment not found in this project")
			return "", "", false
		}
	}
	return svc, env, true
}

// aggregateStatus is the worst status among enabled checks (down > degraded >
// up), "unknown" before any probe, "none" without enabled checks — the same
// rule as a project's health_status.
func aggregateStatus(checks []*store.HealthCheck) string {
	out := "none"
	rank := map[string]int{"none": 0, store.StatusUnknown: 1, store.StatusUp: 2, store.StatusDegraded: 3, store.StatusDown: 4}
	for _, c := range checks {
		if !c.Enabled {
			continue
		}
		if rank[c.Status] > rank[out] {
			out = c.Status
		}
	}
	return out
}

func (s *Server) v1Project(w http.ResponseWriter, r *http.Request, t *store.APIToken) (*store.Project, bool) {
	acc, err := s.tokenAccess(r, t)
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	p, err := s.store.ProjectByKeyFor(r.Context(), acc, r.PathValue("key"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found (project keys can be renamed — use the current key)")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return p, true
}

func (s *Server) v1NeedVault(w http.ResponseWriter) bool {
	if !s.cfg.ModuleVault {
		writeError(w, http.StatusNotFound, "the vault module is disabled on this Rexus")
		return false
	}
	return true
}

func (s *Server) v1NeedScheduler(w http.ResponseWriter) bool {
	if !s.cfg.ModuleScheduler {
		writeError(w, http.StatusNotFound, "the scheduler module is disabled on this Rexus")
		return false
	}
	return true
}

func (s *Server) v1Checks(r *http.Request, p *store.Project, svc, env store.ScopeFilter) ([]checkV1, []*store.HealthCheck, error) {
	checks, err := s.store.ListChecks(r.Context(), store.CheckFilter{ProjectID: p.ID, Service: svc, Environment: env})
	if err != nil {
		return nil, nil, err
	}
	out := make([]checkV1, 0, len(checks))
	for _, c := range checks {
		out = append(out, toCheckV1(c))
	}
	return out, checks, nil
}

func (s *Server) v1Jobs(r *http.Request, p *store.Project, svc, env store.ScopeFilter) ([]jobV1, []*store.Job, error) {
	jobs, err := s.store.ListJobs(r.Context(), store.JobFilter{ProjectID: p.ID, Service: svc, Environment: env})
	if err != nil {
		return nil, nil, err
	}
	out := make([]jobV1, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, toJobV1(j))
	}
	return out, jobs, nil
}

func (s *Server) v1Secrets(r *http.Request, f store.SecretFilter, t *store.APIToken) ([]secretV1, error) {
	acc, err := s.tokenAccess(r, t)
	if err != nil {
		return nil, err
	}
	f.Access = acc
	secrets, err := s.store.ListSecrets(r.Context(), f)
	if err != nil {
		return nil, err
	}
	out := make([]secretV1, 0, len(secrets))
	for _, x := range secrets {
		out = append(out, toSecretV1(x, t))
	}
	return out, nil
}

// ---- endpoints ----

// handleV1Health lets a tool check that its token works.
func (s *Server) handleV1Health(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"token": map[string]any{"name": t.Name, "kind": t.Kind, "role": t.Role, "expires_at": t.ExpiresAt,
			"project": t.ProjectKey, "service": t.ServiceKey, "environment": t.EnvironmentName},
		"time": time.Now().UTC(),
	})
}

func (s *Server) handleV1Projects(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	acc, err := s.tokenAccess(r, t)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	projects, err := s.store.ListProjectsFor(r.Context(), acc)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]projectV1, 0, len(projects))
	for _, p := range projects {
		out = append(out, toProjectV1(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

// handleV1Project is the full picture of one project: checks, jobs and expiring secrets.
func (s *Server) handleV1Project(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	checks, _, err := s.v1Checks(r, p, "", "")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	services, err := s.store.ListServices(r.Context(), p.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	svcs := make([]serviceV1, 0, len(services))
	for _, x := range services {
		svcs = append(svcs, toServiceV1(x))
	}
	resp := map[string]any{"project": toProjectV1(p), "services": svcs, "checks": checks}
	if s.cfg.ModuleScheduler {
		jobs, _, err := s.v1Jobs(r, p, "", "")
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		resp["jobs"] = jobs
	}
	if s.cfg.ModuleVault {
		days := 30
		expiring, err := s.v1Secrets(r, store.SecretFilter{ProjectID: p.ID, ExpiringDays: &days}, t)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		resp["secrets_expiring_30d"] = expiring
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleV1Status is the compact answer a CRM wants: is this client's project OK?
// ?service= and ?environment= narrow it to part of the project.
func (s *Server) handleV1Status(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	svc, env, ok := s.v1Scope(w, r, p)
	if !ok {
		return
	}
	_, checks, err := s.v1Checks(r, p, svc, env)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var up, degraded, down, unknown, paused int
	for _, c := range checks {
		switch {
		case !c.Enabled:
			paused++
		case c.Status == store.StatusUp:
			up++
		case c.Status == store.StatusDegraded:
			degraded++
		case c.Status == store.StatusDown:
			down++
		default:
			unknown++
		}
	}
	resp := map[string]any{
		"key": p.Key, "name": p.Name, "status": aggregateStatus(checks),
		"checks_total": len(checks), "checks_up": up, "checks_degraded": degraded, "checks_down": down,
		"checks_unknown": unknown, "checks_paused": paused,
		"generated_at": time.Now().UTC(),
	}
	if s.cfg.ModuleScheduler {
		_, jobs, err := s.v1Jobs(r, p, svc, env)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		failing := 0
		for _, j := range jobs {
			if j.Enabled && j.LastStatus != nil && *j.LastStatus == "failed" {
				failing++
			}
		}
		resp["jobs_total"], resp["jobs_failing"] = len(jobs), failing
	}
	if s.cfg.ModuleVault && env != store.ScopeNone { // every secret has an environment
		days := 30
		f := store.SecretFilter{ProjectID: p.ID, Service: svc, ExpiringDays: &days}
		if env != "" && env != store.ScopeNone {
			f.EnvironmentID = string(env)
		}
		secrets, err := s.store.ListSecrets(r.Context(), f)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		resp["secrets_expiring_30d"] = len(secrets)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleV1Checks(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	svc, env, ok := s.v1Scope(w, r, p)
	if !ok {
		return
	}
	checks, _, err := s.v1Checks(r, p, svc, env)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": checks})
}

func (s *Server) handleV1Jobs(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedScheduler(w) {
		return
	}
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	svc, env, ok := s.v1Scope(w, r, p)
	if !ok {
		return
	}
	jobs, _, err := s.v1Jobs(r, p, svc, env)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

func (s *Server) handleV1ProjectSecrets(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedVault(w) {
		return
	}
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	svc, env, ok := s.v1Scope(w, r, p)
	if !ok {
		return
	}
	f := store.SecretFilter{ProjectID: p.ID, Service: svc}
	if env == store.ScopeNone { // every secret has an environment
		writeJSON(w, http.StatusOK, map[string]any{"secrets": []secretV1{}})
		return
	}
	if env != "" {
		f.EnvironmentID = string(env)
	}
	secrets, err := s.v1Secrets(r, f, t)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"secrets": secrets})
}

func (s *Server) handleV1Expiring(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedVault(w) {
		return
	}
	days := 30
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 3650 {
			writeError(w, http.StatusBadRequest, "days must be a number from 0 to 3650")
			return
		}
		days = n
	}
	secrets, err := s.v1Secrets(r, store.SecretFilter{ExpiringDays: &days}, t)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": days, "secrets": secrets})
}

// v1Secret looks a secret up in exactly one scope: .../secrets/{env}/{name}
// is a secret of the project itself, .../services/{service}/secrets/{env}/{name}
// one of that service. Same-named secrets in other scopes are never returned.
func (s *Server) v1Secret(w http.ResponseWriter, r *http.Request, t *store.APIToken) (*store.Secret, bool) {
	sec, err := s.store.SecretByName(r.Context(), r.PathValue("key"), r.PathValue("service"), r.PathValue("env"), r.PathValue("name"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "secret not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	// A secret of a project this token can't see is "not found", like any other.
	acc, err := s.tokenAccess(r, t)
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	if ok, err := s.store.CanSee(r.Context(), acc, sec.ProjectID); err != nil {
		s.internalError(w, r, err)
		return nil, false
	} else if !ok {
		writeError(w, http.StatusNotFound, "secret not found")
		return nil, false
	}
	return sec, true
}

func (s *Server) handleV1Secret(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedVault(w) {
		return
	}
	sec, ok := s.v1Secret(w, r, t)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"secret": toSecretV1(sec, t)})
}

// handleV1Reveal returns a secret's current value. Only contributor tokens may
// do it, and every call is audited under the token's name.
func (s *Server) handleV1Reveal(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedVault(w) {
		return
	}
	if t.Role != "contributor" {
		writeError(w, http.StatusForbidden, "this token is read-only (viewer) and can't read secret values — use a contributor token")
		return
	}
	sec, ok := s.v1Secret(w, r, t)
	if !ok {
		return
	}
	value, err := s.openVersion(r, sec, sec.CurrentVersion)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.auditToken(r, t, "secret.reveal", "secret", sec.ID, map[string]any{
		"name": sec.Name, "project": sec.ProjectKey, "service": strOr(sec.ServiceKey, ""), "environment": sec.EnvironmentName,
		"version": sec.CurrentVersion, "via": "api",
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"project": sec.ProjectKey, "service": sec.ServiceKey, "environment": sec.EnvironmentName, "name": sec.Name,
		"version": sec.CurrentVersion, "value": value,
	})
}

func (s *Server) handleV1Services(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	p, ok := s.v1Project(w, r, t)
	if !ok {
		return
	}
	services, err := s.store.ListServices(r.Context(), p.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]serviceV1, 0, len(services))
	for _, x := range services {
		out = append(out, toServiceV1(x))
	}
	writeJSON(w, http.StatusOK, map[string]any{"services": out})
}
