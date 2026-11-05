package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	tokens, err := s.store.ListTokens(r.Context(), store.TokenKindAPI, "", s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": tokens, "max": maxActiveTokens})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in struct {
		Name          string `json:"name"`
		Role          string `json:"role"`
		ExpiresInDays *int   `json:"expires_in_days"` // null = never expires
		// Limit the token to these projects (keys). Omitted or null = every project the creator can see.
		Projects *[]string `json:"projects"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := validChannelName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A token is never more powerful than a contributor: it can't manage users,
	// backups or other tokens, so a leaked one has a limited blast radius.
	if in.Role != "viewer" && in.Role != "contributor" {
		writeError(w, http.StatusBadRequest, "a token's role must be viewer or contributor")
		return
	}
	var expires *time.Time
	if in.ExpiresInDays != nil {
		if *in.ExpiresInDays < 1 || *in.ExpiresInDays > 730 {
			writeError(w, http.StatusBadRequest, "expiry must be between 1 and 730 days (or never)")
			return
		}
		t := time.Now().Add(time.Duration(*in.ExpiresInDays) * 24 * time.Hour)
		expires = &t
	}
	if n, err := s.store.CountActiveTokens(r.Context(), store.TokenKindAPI); err != nil {
		s.internalError(w, r, err)
		return
	} else if n >= maxActiveTokens {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d active tokens — revoke one you no longer use", maxActiveTokens))
		return
	}

	// A token can't be given a project its creator can't see.
	var projectIDs []string
	if in.Projects != nil {
		ids, ok, err := s.store.ProjectIDsByKeys(r.Context(), *in.Projects)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !ok || len(ids) == 0 {
			writeError(w, http.StatusBadRequest, "choose at least one project that exists")
			return
		}
		for _, id := range ids {
			if can, err := s.store.CanSee(r.Context(), s.access(r), id); err != nil {
				s.internalError(w, r, err)
				return
			} else if !can {
				writeError(w, http.StatusBadRequest, "choose at least one project that exists")
				return
			}
		}
		projectIDs = ids
	}

	token, prefix := newToken()
	t, err := s.store.CreateToken(r.Context(), name, prefix, in.Role, crypto.HashToken(token), a.user.ID, expires, projectIDs)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	details := map[string]any{"name": t.Name, "role": t.Role, "prefix": t.Prefix, "expires": "never"}
	if projectIDs != nil {
		details["project_count"] = len(projectIDs)
	}
	if expires != nil {
		details["expires"] = expires.UTC().Format("2006-01-02")
	}
	s.audit(r, a, "token.create", "api_token", t.ID, details)
	if projectIDs != nil {
		keys, _ := s.store.ProjectKeysByIDs(r.Context(), projectIDs)
		for _, id := range projectIDs {
			s.auditProject(r, a, id, "token.project", "api_token", t.ID, map[string]any{"name": t.Name, "project": keys[id]})
		}
	}
	// The only time the token itself is ever returned.
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "meta": t})
}

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request, a *authCtx) {
	id := strings.TrimSpace(r.PathValue("id"))
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "token not found")
		return
	}
	// Deploy tokens are managed by whoever can edit secrets; API tokens by owner/admin only.
	existing, err := s.store.TokenByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "token not found (or already revoked)")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if existing.Kind == store.TokenKindDeploy {
		if !canWrite(a.user.Role) {
			writeError(w, http.StatusForbidden, "your role can't revoke deploy tokens")
			return
		}
		if existing.ProjectID == nil || !s.visible(w, r, *existing.ProjectID, "token not found (or already revoked)") {
			return
		}
	} else if !requireAdmin(w, a) {
		return
	}
	t, err := s.store.RevokeToken(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "token not found (or already revoked)")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "token.revoke", "api_token", t.ID, map[string]any{"name": t.Name, "prefix": t.Prefix})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
