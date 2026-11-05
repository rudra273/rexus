package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rexus/internal/scheduler"
	"rexus/internal/store"
)

type jobInput struct {
	ProjectKey     *string           `json:"project_key"`    // required on create; can't change afterwards
	ServiceID      *string           `json:"service_id"`     // "" = the project directly; omitted on update = unchanged
	EnvironmentID  *string           `json:"environment_id"` // "" = no environment; omitted on update = unchanged
	Name           string            `json:"name"`
	Schedule       string            `json:"schedule"`
	URL            string            `json:"url"`
	Method         string            `json:"method"`
	Body           string            `json:"body"`
	ExpectedStatus string            `json:"expected_status"`
	Headers        map[string]string `json:"headers"`
	TimeoutSeconds *int              `json:"timeout_seconds"`
	Retries        *int              `json:"retries"`
	Enabled        *bool             `json:"enabled"`
}

// jobView adds request headers to the API response. Writers see real values
// (they need them to edit); Viewers see masked values.
type jobView struct {
	*store.Job
	Headers map[string]string `json:"headers"`
}

var (
	headerNameRe   = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_|~-]{1,100}$`)
	allowedMethods = map[string]bool{"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}
)

func (s *Server) view(j *store.Job, a *authCtx) (*jobView, error) {
	v := &jobView{Job: j, Headers: map[string]string{}}
	if len(j.HeadersEnc) == 0 {
		return v, nil
	}
	pt, err := s.keys.Decrypt(j.HeadersEnc, scheduler.HeadersAAD)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(pt, &v.Headers); err != nil {
		return nil, err
	}
	if !canWrite(a.user.Role) {
		for k := range v.Headers {
			v.Headers[k] = "••••••••"
		}
	}
	return v, nil
}

// buildJob validates input and fills j (new or existing).
func (s *Server) buildJob(r *http.Request, in *jobInput, j *store.Job) error {
	name, err := validateName(in.Name)
	if err != nil {
		return err
	}
	j.Name = name

	// Every job belongs to a project. It is chosen on create and stays put:
	// moving a job to another project is not supported.
	key := ""
	if in.ProjectKey != nil {
		key = strings.ToLower(strings.TrimSpace(*in.ProjectKey))
	}
	switch {
	case j.ID == "" && key == "":
		return errors.New("choose a project for this job")
	case j.ID == "":
		p, err := s.store.ProjectByKey(r.Context(), key)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("project %q not found", key)
		}
		if err != nil {
			return err
		}
		j.ProjectID, j.ProjectKey = p.ID, p.Key
	case key != "" && key != j.ProjectKey:
		return errors.New("a job can't be moved to another project — create a new job there instead")
	}
	// On update, omitted scope fields keep their value; "" clears them.
	svcIn, envIn := in.ServiceID, in.EnvironmentID
	if j.ID != "" {
		svcIn, envIn = keepIfOmitted(svcIn, j.ServiceID), keepIfOmitted(envIn, j.EnvironmentID)
	}
	svc, env, err := s.resolveScope(r, j.ProjectID, svcIn, envIn)
	if err != nil {
		return err
	}
	j.ServiceID, j.EnvironmentID = idOrNil(svc), envIDOrNil(env)

	sched := strings.TrimSpace(in.Schedule)
	if err := scheduler.Validate(sched); err != nil {
		return err
	}
	j.Schedule = sched

	u, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("URL must be a full http:// or https:// address")
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = "GET"
	}
	if !allowedMethods[method] {
		return fmt.Errorf("unsupported method %q", method)
	}
	if len(in.Body) > 64*1024 {
		return errors.New("request body must be at most 64 KB")
	}
	expected := strings.TrimSpace(in.ExpectedStatus)
	if expected == "" {
		expected = "200-299"
	}
	if _, err := scheduler.ParseExpectedStatus(expected); err != nil {
		return err
	}
	j.Config = store.HTTPConfig{URL: u.String(), Method: method, Body: in.Body, ExpectedStatus: expected}

	if len(in.Headers) > 20 {
		return errors.New("at most 20 headers")
	}
	headers := map[string]string{}
	for k, v := range in.Headers {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if !headerNameRe.MatchString(k) {
			return fmt.Errorf("invalid header name %q", k)
		}
		if strings.ContainsAny(v, "\r\n") || len(v) > 8192 {
			return fmt.Errorf("invalid value for header %q", k)
		}
		headers[k] = v
	}
	j.HeadersEnc = nil
	if len(headers) > 0 {
		raw, _ := json.Marshal(headers)
		if j.HeadersEnc, err = s.keys.Encrypt(raw, scheduler.HeadersAAD); err != nil {
			return err
		}
	}

	j.TimeoutSeconds = 30
	if in.TimeoutSeconds != nil {
		j.TimeoutSeconds = *in.TimeoutSeconds
	}
	if j.TimeoutSeconds < 1 || j.TimeoutSeconds > 300 {
		return errors.New("timeout must be 1–300 seconds")
	}
	j.Retries = 0
	if in.Retries != nil {
		j.Retries = *in.Retries
	}
	if j.Retries < 0 || j.Retries > 5 {
		return errors.New("retries must be 0–5")
	}
	j.Enabled = true
	if in.Enabled != nil {
		j.Enabled = *in.Enabled
	}

	j.NextRunAt = nil
	if j.Enabled {
		n, err := scheduler.Next(j.Schedule, time.Now())
		if err != nil {
			return err
		}
		j.NextRunAt = &n
	}
	return nil
}

func (s *Server) loadJob(w http.ResponseWriter, r *http.Request) (*store.Job, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "job not found")
		return nil, false
	}
	j, err := s.store.JobByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "job not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return j, true
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var f store.JobFilter
	var ok bool
	if f.Service, ok = scopeFilterParam(w, r, "service"); !ok {
		return
	}
	if f.Environment, ok = scopeFilterParam(w, r, "environment"); !ok {
		return
	}
	if key := r.URL.Query().Get("project"); key != "" {
		p, err := s.store.ProjectByKey(r.Context(), key)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		f.ProjectID = p.ID
	}
	jobs, err := s.store.ListJobs(r.Context(), f)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The list doesn't include headers; open a job to see them.
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	v, err := s.view(j, a)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": v})
}

func (s *Server) handleCreateJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	var in jobInput
	if !decodeJSON(w, r, &in) {
		return
	}
	j := &store.Job{}
	if err := s.buildJob(r, &in, j); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	created, err := s.store.CreateJob(r.Context(), j, a.user.ID)
	if errors.Is(err, store.ErrInvalidScope) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "job.create", "job", created.ID, scopeDetails(map[string]any{"name": created.Name, "url": created.Config.URL,
		"project": created.ProjectKey}, created.ServiceKey, created.EnvironmentName))
	v, err := s.view(created, a)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"job": v})
}

func (s *Server) handleUpdateJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	var in jobInput
	if !decodeJSON(w, r, &in) {
		return
	}
	before := *j
	if err := s.buildJob(r, &in, j); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := s.store.UpdateJob(r.Context(), j)
	if errors.Is(err, store.ErrInvalidScope) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "job.update", "job", updated.ID, scopeDetails(map[string]any{"name": updated.Name, "enabled": updated.Enabled,
		"project": updated.ProjectKey}, updated.ServiceKey, updated.EnvironmentName))
	if !sameID(before.ServiceID, updated.ServiceID) || !sameID(before.EnvironmentID, updated.EnvironmentID) {
		s.audit(r, a, "job.move", "job", updated.ID, map[string]any{"name": updated.Name, "project": updated.ProjectKey,
			"from_service": strOr(before.ServiceKey, ""), "service": strOr(updated.ServiceKey, ""),
			"from_environment": strOr(before.EnvironmentName, ""), "environment": strOr(updated.EnvironmentName, "")})
	}
	v, err := s.view(updated, a)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": v})
}

func (s *Server) handleDeleteJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteJob(r.Context(), j.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "job.delete", "job", j.ID, map[string]any{"name": j.Name})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRunJob(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	runID, err := s.engine.RunNow(r.Context(), j)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "job.run", "job", j.ID, map[string]any{"name": j.Name, "run_id": runID})
	writeJSON(w, http.StatusAccepted, map[string]any{"run_id": runID})
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request, a *authCtx) {
	j, ok := s.loadJob(w, r)
	if !ok {
		return
	}
	limit := 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	runs, err := s.store.ListRuns(r.Context(), j.ID, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

func (s *Server) handleSchedulePreview(w http.ResponseWriter, r *http.Request, a *authCtx) {
	times, err := scheduler.Preview(r.URL.Query().Get("expr"), 3)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"valid": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"valid": true, "next": times})
}
