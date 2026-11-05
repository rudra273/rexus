package server

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"rexus/internal/store"
)

// canWrite: Owner, Admin and Contributor can change projects and jobs;
// Viewer is read-only (plan.md §5).
func canWrite(role string) bool {
	return role == "owner" || role == "admin" || role == "contributor"
}

func requireWrite(w http.ResponseWriter, a *authCtx) bool {
	if !canWrite(a.user.Role) {
		writeError(w, http.StatusForbidden, "your role is read-only")
		return false
	}
	return true
}

func validateDescription(d string) (string, error) {
	d = strings.TrimSpace(d)
	if utf8.RuneCountInString(d) > 2000 {
		return "", errors.New("description must be at most 2000 characters")
	}
	return d, nil
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request, a *authCtx) {
	projects, err := s.store.ListProjectsFor(r.Context(), s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request, a *authCtx) {
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": p})
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in struct {
		Key         string `json:"key"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	key, err := store.NormalizeProjectKey(in.Key)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name, err := validateName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	desc, err := validateDescription(in.Description)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	p, err := s.store.CreateProject(r.Context(), key, name, desc, a.user.ID)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "project key '"+key+"' is already taken")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "project.create", "project", p.ID, map[string]any{"key": p.Key, "name": p.Name})
	writeJSON(w, http.StatusCreated, map[string]any{"project": p})
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	var in struct {
		Key         *string `json:"key"`
		Name        *string `json:"name"`
		Description *string `json:"description"`
		OwnerOnly   *bool   `json:"owner_only"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	// Hiding a project from every admin is the owner's call alone.
	if in.OwnerOnly != nil && a.user.Role != "owner" {
		writeError(w, http.StatusForbidden, "only the owner can mark a project owner-only")
		return
	}
	var err error
	key, name, desc := p.Key, p.Name, p.Description
	if in.Key != nil {
		if key, err = store.NormalizeProjectKey(*in.Key); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if in.Name != nil {
		if name, err = validateName(*in.Name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if in.Description != nil {
		if desc, err = validateDescription(*in.Description); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	updated, err := s.store.UpdateProject(r.Context(), p.ID, key, name, desc)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "project key '"+key+"' is already taken")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if in.OwnerOnly != nil && *in.OwnerOnly != p.OwnerOnly {
		if err := s.store.SetProjectOwnerOnly(r.Context(), p.ID, *in.OwnerOnly); err != nil {
			s.internalError(w, r, err)
			return
		}
		updated.OwnerOnly = *in.OwnerOnly
		s.audit(r, a, "project.owner_only", "project", p.ID, map[string]any{"key": key, "owner_only": *in.OwnerOnly})
	}
	if key != p.Key {
		s.audit(r, a, "project.rename", "project", p.ID, map[string]any{"from": p.Key, "to": key})
	}
	s.audit(r, a, "project.update", "project", p.ID, map[string]any{"key": key})
	writeJSON(w, http.StatusOK, map[string]any{"project": updated})
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteProject(r.Context(), p.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "project.delete", "project", p.ID, map[string]any{"key": p.Key, "name": p.Name})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
