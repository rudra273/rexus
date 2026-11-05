package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"rexus/internal/store"
)

// Services are optional groups inside a project (frontend, backend, worker…).
// They only organize secrets, jobs and checks — they are not an access
// boundary: every role still sees and edits the whole project.

const maxServicesPerProject = 50

type serviceInput struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Description   string  `json:"description"`
	RepositoryURL *string `json:"repository_url"`
	RootDirectory *string `json:"root_directory"`
}

func optionalText(p *string, max int, what string) (*string, error) {
	if p == nil {
		return nil, nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(v) > max || strings.ContainsAny(v, "\r\n\t ") {
		return nil, fmt.Errorf("%s must be at most %d characters, without spaces", what, max)
	}
	return &v, nil
}

func (in *serviceInput) apply(x *store.Service) error {
	key, err := store.NormalizeServiceKey(in.Key)
	if err != nil {
		return err
	}
	name, err := validateName(in.Name)
	if err != nil {
		return err
	}
	desc, err := validateDescription(in.Description)
	if err != nil {
		return err
	}
	repo, err := optionalText(in.RepositoryURL, 500, "repository URL")
	if err != nil {
		return err
	}
	root, err := optionalText(in.RootDirectory, 200, "root directory")
	if err != nil {
		return err
	}
	x.Key, x.Name, x.Description, x.RepositoryURL, x.RootDirectory = key, name, desc, repo, root
	return nil
}

func (s *Server) loadProject(w http.ResponseWriter, r *http.Request) (*store.Project, bool) {
	p, err := s.store.ProjectByKey(r.Context(), r.PathValue("key"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return p, true
}

func (s *Server) loadService(w http.ResponseWriter, r *http.Request) (*store.Service, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "service not found")
		return nil, false
	}
	x, err := s.store.ServiceByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "service not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return x, true
}

func (s *Server) handleListServices(w http.ResponseWriter, r *http.Request, a *authCtx) {
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	services, err := s.store.ListServices(r.Context(), p.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"services": services})
}

func (s *Server) handleCreateService(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	var in serviceInput
	if !decodeJSON(w, r, &in) {
		return
	}
	x := &store.Service{ProjectID: p.ID}
	if err := in.apply(x); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if p.ServiceCount >= maxServicesPerProject {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("a project can have at most %d services", maxServicesPerProject))
		return
	}
	created, err := s.store.CreateService(r.Context(), x, a.user.ID)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "this project already has a service with key '"+x.Key+"'")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "service.create", "service", created.ID, map[string]any{"project": p.Key, "key": created.Key, "name": created.Name})
	writeJSON(w, http.StatusCreated, map[string]any{"service": created})
}

func (s *Server) handleUpdateService(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	x, ok := s.loadService(w, r)
	if !ok {
		return
	}
	var in serviceInput
	if !decodeJSON(w, r, &in) {
		return
	}
	oldKey := x.Key
	if err := in.apply(x); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := s.store.UpdateService(r.Context(), x)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "this project already has a service with key '"+x.Key+"'")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	details := map[string]any{"project": updated.ProjectKey, "key": updated.Key}
	if oldKey != updated.Key {
		details["renamed_from"] = oldKey
	}
	s.audit(r, a, "service.update", "service", updated.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"service": updated})
}

// handleDeleteService deletes an empty service only. Its secrets, jobs and
// checks are never removed with it: move or delete them first.
func (s *Server) handleDeleteService(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	x, ok := s.loadService(w, r)
	if !ok {
		return
	}
	inUse := func() {
		writeError(w, http.StatusConflict, fmt.Sprintf(
			"'%s' still has %d secret(s), %d job(s) and %d health check(s) — move or delete them first",
			x.Name, x.SecretCount, x.JobCount, x.CheckCount))
	}
	if x.SecretCount+x.JobCount+x.CheckCount > 0 {
		inUse()
		return
	}
	err := s.store.DeleteService(r.Context(), x.ID)
	if errors.Is(err, store.ErrInUse) { // something was added in the meantime
		if fresh, ferr := s.store.ServiceByID(r.Context(), x.ID); ferr == nil {
			x = fresh
		}
		inUse()
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "service.delete", "service", x.ID, map[string]any{"project": x.ProjectKey, "key": x.Key, "name": x.Name})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- scope helpers shared by secrets, jobs and checks ----

// resolveScope checks that an optional service and environment (IDs from a
// request body; nil or "" = none) belong to project projectID. The database
// enforces the same rule; this gives a clear message first.
func (s *Server) resolveScope(r *http.Request, projectID string, serviceID, environmentID *string) (*store.Service, *store.Environment, error) {
	var svc *store.Service
	var env *store.Environment
	if serviceID != nil && *serviceID != "" {
		if !store.IsUUID(*serviceID) {
			return nil, nil, errors.New("service not found")
		}
		x, err := s.store.ServiceByID(r.Context(), *serviceID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && x.ProjectID != projectID) {
			return nil, nil, errors.New("service not found in this project")
		}
		if err != nil {
			return nil, nil, err
		}
		svc = x
	}
	if environmentID != nil && *environmentID != "" {
		if !store.IsUUID(*environmentID) {
			return nil, nil, errors.New("environment not found")
		}
		e, err := s.store.EnvironmentByID(r.Context(), *environmentID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && e.ProjectID != projectID) {
			return nil, nil, errors.New("environment not found in this project")
		}
		if err != nil {
			return nil, nil, err
		}
		env = e
	}
	return svc, env, nil
}

// scopeFilterParam reads a "service" / "environment" query parameter of the
// session API: missing = all, "-" = none, otherwise an ID.
func scopeFilterParam(w http.ResponseWriter, r *http.Request, name string) (store.ScopeFilter, bool) {
	f := store.ScopeFilter(strings.TrimSpace(r.URL.Query().Get(name)))
	if !f.Valid() {
		writeError(w, http.StatusBadRequest, name+" must be an ID or '-' (none)")
		return "", false
	}
	return f, true
}

// keepIfOmitted: on an update, a scope field left out of the body (or null)
// keeps the current value; send "" to clear it.
func keepIfOmitted(in, current *string) *string {
	if in == nil {
		return current
	}
	return in
}

func idOrNil(svc *store.Service) *string {
	if svc == nil {
		return nil
	}
	return &svc.ID
}

func envIDOrNil(e *store.Environment) *string {
	if e == nil {
		return nil
	}
	return &e.ID
}

func strOr(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

func sameID(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// scopeDetails is the scope part of an audit entry.
func scopeDetails(d map[string]any, serviceKey, environment *string) map[string]any {
	d["service"] = strOr(serviceKey, "")
	if environment != nil {
		d["environment"] = *environment
	}
	return d
}
