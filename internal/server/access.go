package server

import (
	"context"
	"errors"
	"net/http"

	"rexus/internal/store"
)

// Project access (plan.md Phase 10). Who may see which project is one rule, in the
// store (store.Access). Every handler gets the caller's Access from the request:
// the owner sees everything; everyone else is filtered. A project (or anything
// inside one) the caller can't see answers 404, exactly like one that doesn't exist.

type reqStateKey struct{}

// reqState travels with an authenticated request.
type reqState struct {
	access  store.Access
	project string // the project this request touched, for the audit log
}

func withReqState(r *http.Request, a *authCtx) *http.Request {
	st := &reqState{}
	if a.user.Role != "owner" {
		st.access = store.Access{Viewer: a.user.ID}
	}
	return r.WithContext(context.WithValue(r.Context(), reqStateKey{}, st))
}

func stateOf(r *http.Request) *reqState {
	if st, ok := r.Context().Value(reqStateKey{}).(*reqState); ok {
		return st
	}
	return &reqState{}
}

// access is what the caller may see. Outside an authenticated request it is unrestricted.
func (s *Server) access(r *http.Request) store.Access { return stateOf(r).access }

// noteProject records which project a request is about; the audit entry written
// for it carries that, so people only see the history of projects they can see.
func (s *Server) noteProject(r *http.Request, projectID string) {
	if st := stateOf(r); st.project == "" {
		st.project = projectID
	}
}

// visible reports whether the caller may see the project; if not it answers 404 with notFoundMsg.
func (s *Server) visible(w http.ResponseWriter, r *http.Request, projectID, notFoundMsg string) bool {
	ok, err := s.store.CanSee(r.Context(), s.access(r), projectID)
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	if !ok {
		writeError(w, http.StatusNotFound, notFoundMsg)
		return false
	}
	s.noteProject(r, projectID)
	return true
}

// projectByKey finds a project the caller may see (404 otherwise).
func (s *Server) projectByKey(w http.ResponseWriter, r *http.Request, key string) (*store.Project, bool) {
	p, err := s.store.ProjectByKeyFor(r.Context(), s.access(r), key)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	s.noteProject(r, p.ID)
	return p, true
}

// tokenAccess is what an API token may see: nothing more than the person who
// created it (looked up live, so reducing their access reduces the token's), and
// only the chosen projects if the token was limited to some.
func (s *Server) tokenAccess(r *http.Request, t *store.APIToken) (store.Access, error) {
	var a store.Access
	switch {
	case t.CreatorID == nil:
		a.Viewer = store.NoOne // the creator was removed
	case t.CreatorRole != nil && *t.CreatorRole == "owner":
		// the owner sees everything
	default:
		a.Viewer = *t.CreatorID
	}
	if !t.AllProjects {
		ids, err := s.store.TokenProjectIDs(r.Context(), t.ID)
		if err != nil {
			return a, err
		}
		a.Only = ids
	}
	return a, nil
}
