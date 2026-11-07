package server

import (
	"errors"
	"net/http"

	"rexus/internal/retention"
)

// requireOwner: how long history is kept decides what evidence survives, so only the owner may change it.
// An admin could otherwise shorten the audit log to hide their own actions.
func requireOwner(w http.ResponseWriter, a *authCtx) bool {
	if a.user.Role != "owner" {
		writeError(w, http.StatusForbidden, "only the owner can change data retention")
		return false
	}
	return true
}

func (s *Server) retentionError(w http.ResponseWriter, r *http.Request, err error) {
	var bad *retention.InvalidError
	if errors.As(err, &bad) {
		writeError(w, http.StatusBadRequest, bad.Msg)
		return
	}
	s.internalError(w, r, err)
}

func (s *Server) retentionOverview(w http.ResponseWriter, r *http.Request, a *authCtx) {
	o, err := s.retention.Overview(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"overview": o, "editable": a.user.Role == "owner"})
}

func (s *Server) handleRetention(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	s.retentionOverview(w, r, a)
}

// retentionInput is the policy as the page sends it; every field is required, so a typo can't silently reset one.
type retentionInput struct {
	JobRunDays         *int `json:"job_run_days"`
	HealthResultDays   *int `json:"health_result_days"`
	HealthEventDays    *int `json:"health_event_days"`
	AlertLogDays       *int `json:"alert_log_days"`
	AuditDays          *int `json:"audit_days"`
	SecretVersionsKeep *int `json:"secret_versions_keep"`
}

func (in retentionInput) policy() (retention.Policy, bool) {
	if in.JobRunDays == nil || in.HealthResultDays == nil || in.HealthEventDays == nil ||
		in.AlertLogDays == nil || in.AuditDays == nil || in.SecretVersionsKeep == nil {
		return retention.Policy{}, false
	}
	return retention.Policy{JobRunDays: *in.JobRunDays, HealthResultDays: *in.HealthResultDays, HealthEventDays: *in.HealthEventDays,
		AlertLogDays: *in.AlertLogDays, AuditDays: *in.AuditDays, SecretVersionsKeep: *in.SecretVersionsKeep}, true
}

// handlePreviewRetention counts what a policy would delete right now, without deleting anything.
func (s *Server) handlePreviewRetention(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireOwner(w, a) {
		return
	}
	var in retentionInput
	if !decodeJSON(w, r, &in) {
		return
	}
	p, ok := in.policy()
	if !ok {
		writeError(w, http.StatusBadRequest, "every retention value is required")
		return
	}
	if err := p.Validate(); err != nil {
		s.retentionError(w, r, err)
		return
	}
	p.Confirmed = true // the preview shows what saving would delete
	counts, err := s.retention.Count(r.Context(), p)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": counts})
}

func (s *Server) handleSaveRetention(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireOwner(w, a) {
		return
	}
	var in retentionInput
	if !decodeJSON(w, r, &in) {
		return
	}
	p, ok := in.policy()
	if !ok {
		writeError(w, http.StatusBadRequest, "every retention value is required")
		return
	}
	old, err := s.retention.Policy(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	saved, err := s.retention.Save(r.Context(), p)
	if err != nil {
		s.retentionError(w, r, err)
		return
	}
	s.audit(r, a, "retention.update", "retention", "", map[string]any{"from": old, "to": saved})
	s.retentionOverview(w, r, a)
}

// ---- the weekly cleanup as a built-in ("system") job ----

func (s *Server) systemJobs(w http.ResponseWriter, r *http.Request, a *authCtx) {
	v, err := s.retention.Job(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": []any{v}, "editable": a.user.Role == "owner"})
}

func (s *Server) handleSystemJobs(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	s.systemJobs(w, r, a)
}

func (s *Server) handleSystemJobRuns(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.knownSystemJob(w, r) {
		return
	}
	runs, err := s.retention.Runs(r.Context(), 50)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

func (s *Server) knownSystemJob(w http.ResponseWriter, r *http.Request) bool {
	if r.PathValue("key") != retention.JobKey {
		writeError(w, http.StatusNotFound, "job not found")
		return false
	}
	return true
}

// handlePatchSystemJob stops or resumes the job.
func (s *Server) handlePatchSystemJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireOwner(w, a) || !s.knownSystemJob(w, r) {
		return
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	if err := s.retention.SetEnabled(r.Context(), *in.Enabled); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "retention.job", "retention", retention.JobKey, map[string]any{"enabled": *in.Enabled})
	s.systemJobs(w, r, a)
}

// handleRunSystemJob starts the cleanup now, in the background.
func (s *Server) handleRunSystemJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireOwner(w, a) || !s.knownSystemJob(w, r) {
		return
	}
	if err := s.retention.RunAsync(r.Context(), a.user.ID); err != nil {
		if errors.Is(err, retention.ErrBusy) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "retention.run", "retention", retention.JobKey, map[string]any{"manual": true})
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
}
