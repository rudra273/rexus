package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"rexus/internal/scheduler"
	"rexus/internal/store"
)

const maxChecksPerProject = 20

type checkInput struct {
	Name              string `json:"name"`
	URL               string `json:"url"`
	Method            string `json:"method"`
	IntervalSeconds   *int   `json:"interval_seconds"`
	TimeoutSeconds    *int   `json:"timeout_seconds"`
	ExpectedStatus    string `json:"expected_status"`
	MaxResponseMS     *int   `json:"max_response_ms"` // null/omitted = don't flag slow responses
	SSLWarnDays       *int   `json:"ssl_warn_days"`   // null/omitted = don't flag expiring certificates
	DownThreshold     *int   `json:"down_threshold"`
	RecoveryThreshold *int   `json:"recovery_threshold"`
	Enabled           *bool  `json:"enabled"`
}

func intOr(p *int, def int) int {
	if p == nil {
		return def
	}
	return *p
}

// apply validates the input and copies it onto c (new or existing).
func (in *checkInput) apply(c *store.HealthCheck) error {
	name, err := validateName(in.Name)
	if err != nil {
		return err
	}
	c.Name = name

	u, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("URL must be a full http:// or https:// address")
	}
	c.URL = u.String()

	c.Method = strings.ToUpper(strings.TrimSpace(in.Method))
	if c.Method == "" {
		c.Method = "GET"
	}
	if c.Method != "GET" && c.Method != "HEAD" {
		return errors.New("method must be GET or HEAD")
	}

	c.IntervalSeconds = intOr(in.IntervalSeconds, 300)
	if c.IntervalSeconds < 60 || c.IntervalSeconds > 86400 {
		return errors.New("interval must be between 1 minute and 24 hours")
	}
	c.TimeoutSeconds = intOr(in.TimeoutSeconds, 10)
	if c.TimeoutSeconds < 1 || c.TimeoutSeconds > 60 {
		return errors.New("timeout must be 1–60 seconds")
	}
	if c.TimeoutSeconds >= c.IntervalSeconds {
		return errors.New("timeout must be shorter than the interval")
	}

	c.ExpectedStatus = strings.TrimSpace(in.ExpectedStatus)
	if c.ExpectedStatus == "" {
		c.ExpectedStatus = "200-299"
	}
	if _, err := scheduler.ParseExpectedStatus(c.ExpectedStatus); err != nil {
		return err
	}

	c.MaxResponseMS = nil
	if in.MaxResponseMS != nil {
		if *in.MaxResponseMS < 1 || *in.MaxResponseMS > 600000 {
			return errors.New("slow-response limit must be 1–600000 ms")
		}
		c.MaxResponseMS = in.MaxResponseMS
	}
	c.SSLWarnDays = nil
	if in.SSLWarnDays != nil && u.Scheme == "https" {
		if *in.SSLWarnDays < 1 || *in.SSLWarnDays > 365 {
			return errors.New("SSL warning must be 1–365 days")
		}
		c.SSLWarnDays = in.SSLWarnDays
	}

	c.DownThreshold = intOr(in.DownThreshold, 3)
	c.RecoveryThreshold = intOr(in.RecoveryThreshold, 1)
	if c.DownThreshold < 1 || c.DownThreshold > 20 || c.RecoveryThreshold < 1 || c.RecoveryThreshold > 20 {
		return errors.New("down and recovery thresholds must be 1–20")
	}
	c.Enabled = true
	if in.Enabled != nil {
		c.Enabled = *in.Enabled
	}
	return nil
}

func (s *Server) loadCheck(w http.ResponseWriter, r *http.Request) (*store.HealthCheck, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "health check not found")
		return nil, false
	}
	c, err := s.store.HealthCheckByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "health check not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return c, true
}

func (s *Server) handleListChecks(w http.ResponseWriter, r *http.Request, a *authCtx) {
	checks, err := s.store.ListHealthChecks(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": checks})
}

func (s *Server) handleListProjectChecks(w http.ResponseWriter, r *http.Request, a *authCtx) {
	p, err := s.store.ProjectByKey(r.Context(), r.PathValue("key"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	checks, err := s.store.ListProjectChecks(r.Context(), p.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": checks})
}

func (s *Server) handleCreateCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	p, err := s.store.ProjectByKey(r.Context(), r.PathValue("key"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var in checkInput
	if !decodeJSON(w, r, &in) {
		return
	}
	c := &store.HealthCheck{ProjectID: p.ID}
	if err := in.apply(c); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if n, err := s.store.CountProjectChecks(r.Context(), p.ID); err != nil {
		s.internalError(w, r, err)
		return
	} else if n >= maxChecksPerProject {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("a project can have at most %d health checks", maxChecksPerProject))
		return
	}
	created, err := s.store.CreateHealthCheck(r.Context(), c, a.user.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "check.create", "check", created.ID, map[string]any{"name": created.Name, "project": p.Key, "url": created.URL})
	writeJSON(w, http.StatusCreated, map[string]any{"check": created})
}

func (s *Server) handleGetCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	uptime, err := s.store.CheckUptime(r.Context(), c.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	events, err := s.store.ListHealthEvents(r.Context(), c.ID, 20)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"check": c, "uptime": uptime, "events": events})
}

func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	var in checkInput
	if !decodeJSON(w, r, &in) {
		return
	}
	oldURL := c.URL
	if err := in.apply(c); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A new URL is a new target: start the status over.
	updated, err := s.store.UpdateHealthCheck(r.Context(), c, c.URL != oldURL)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "check.update", "check", updated.ID, map[string]any{"name": updated.Name, "project": updated.ProjectKey, "enabled": updated.Enabled})
	writeJSON(w, http.StatusOK, map[string]any{"check": updated})
}

func (s *Server) handleDeleteCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteHealthCheck(r.Context(), c.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "check.delete", "check", c.ID, map[string]any{"name": c.Name, "project": c.ProjectKey})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRunCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	s.engine.CheckNow(c)
	s.audit(r, a, "check.run", "check", c.ID, map[string]any{"name": c.Name})
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// seriesRanges maps the chart's range tabs to a window and a bucket size.
var seriesRanges = map[string][2]time.Duration{
	"1h":  {time.Hour, time.Minute},
	"6h":  {6 * time.Hour, 3 * time.Minute},
	"24h": {24 * time.Hour, 12 * time.Minute},
	"7d":  {7 * 24 * time.Hour, 84 * time.Minute},
	"30d": {30 * 24 * time.Hour, 6 * time.Hour},
}

func (s *Server) handleCheckSeries(w http.ResponseWriter, r *http.Request, a *authCtx) {
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "24h"
	}
	spec, ok := seriesRanges[rng]
	if !ok {
		writeError(w, http.StatusBadRequest, "range must be 1h, 6h, 24h, 7d or 30d")
		return
	}
	buckets, err := s.store.CheckSeries(r.Context(), c.ID, spec[0], spec[1])
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"range":          rng,
		"window_seconds": int(spec[0].Seconds()),
		"bucket_seconds": int(spec[1].Seconds()),
		"buckets":        buckets,
	})
}
