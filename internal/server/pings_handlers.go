package server

import (
	"net/http"
	"time"

	"rexus/internal/scheduler"
	"rexus/internal/store"
)

// setJobEnabled pauses or resumes one job, scheduling a resumed job for its next slot.
func (s *Server) setJobEnabled(r *http.Request, j *store.Job, enabled bool) error {
	var next *time.Time
	if enabled {
		n, err := scheduler.Next(j.Schedule, time.Now())
		if err != nil {
			return err
		}
		next = &n
	}
	return s.store.SetJobEnabled(r.Context(), j.ID, enabled, next)
}

type enabledInput struct {
	Enabled *bool `json:"enabled"`
}

// handlePatchCheck pauses or resumes a check without needing the whole form.
func (s *Server) handlePatchCheck(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	c, ok := s.loadCheck(w, r)
	if !ok {
		return
	}
	var in enabledInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	if err := s.store.SetCheckEnabled(r.Context(), c.ID, *in.Enabled); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "check.update", "check", c.ID, map[string]any{"name": c.Name, "project": c.ProjectKey, "enabled": *in.Enabled})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handlePatchJob pauses or resumes a job without needing the whole form.
func (s *Server) handlePatchJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	var in enabledInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	if err := s.setJobEnabled(r, j, *in.Enabled); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.audit(r, a, "job.update", "job", j.ID, map[string]any{"name": j.Name, "project": j.ProjectKey, "enabled": *in.Enabled})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handlePauseProject pauses or resumes every health check and job of a project (a maintenance window).
func (s *Server) handlePauseProject(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	var in struct {
		Paused *bool `json:"paused"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Paused == nil {
		writeError(w, http.StatusBadRequest, "paused is required")
		return
	}
	enabled := !*in.Paused
	nChecks, err := s.store.SetProjectChecksEnabled(r.Context(), p.ID, enabled)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var nJobs int64
	if s.cfg.ModuleScheduler {
		jobs, err := s.store.ListJobs(r.Context(), store.JobFilter{ProjectID: p.ID, Access: s.access(r)})
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		for _, j := range jobs {
			if j.Enabled == enabled {
				continue
			}
			if err := s.setJobEnabled(r, j, enabled); err != nil {
				s.internalError(w, r, err)
				return
			}
			nJobs++
		}
	}
	action := "project.pings_pause"
	if enabled {
		action = "project.pings_resume"
	}
	s.audit(r, a, action, "project", p.ID, map[string]any{"project": p.Key, "checks": nChecks, "jobs": nJobs})
	writeJSON(w, http.StatusOK, map[string]any{"checks": nChecks, "jobs": nJobs})
}
