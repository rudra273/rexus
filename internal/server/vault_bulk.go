package server

import (
	"errors"
	"fmt"
	"net/http"
	"sort"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

// maxBulkSecrets keeps one request reasonable; an .env file has far fewer lines.
const maxBulkSecrets = 200

// handleBulkSecrets adds many secrets to one environment (and one service, or the
// project itself) in a single call — what "paste your .env" does in the UI. Names
// that already exist are skipped, or get a new version if overwrite is set (and
// the value really differs). Everything is validated before anything is written.
func (s *Server) handleBulkSecrets(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	env, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	var in struct {
		ServiceID *string `json:"service_id"` // nil / "" = the project directly
		Overwrite bool    `json:"overwrite"`
		Secrets   []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"secrets"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.Secrets) == 0 {
		writeError(w, http.StatusBadRequest, "add at least one secret")
		return
	}
	if len(in.Secrets) > maxBulkSecrets {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d secrets at a time", maxBulkSecrets))
		return
	}
	svc, _, err := s.resolveScope(r, env.ProjectID, in.ServiceID, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Validate everything first, so a typo on line 40 doesn't leave 39 secrets half-added.
	seen := map[string]bool{}
	for _, x := range in.Secrets {
		if !secretNameRe.MatchString(x.Name) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%q is not a valid secret name (letters, numbers, dots, dashes and underscores)", x.Name))
			return
		}
		if seen[x.Name] {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%q appears more than once", x.Name))
			return
		}
		seen[x.Name] = true
		if err := validateValue(x.Value); err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%s: %s", x.Name, err.Error()))
			return
		}
	}

	scope := store.ScopeNone
	if svc != nil {
		scope = store.ScopeFilter(svc.ID)
	}
	existingList, err := s.store.ListSecrets(r.Context(), store.SecretFilter{ProjectID: env.ProjectID, EnvironmentID: env.ID, Service: scope})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	existing := map[string]*store.Secret{}
	for _, e := range existingList {
		existing[e.Name] = e
	}

	created, updated, unchanged, skipped := []string{}, []string{}, []string{}, []string{}
	for _, x := range in.Secrets {
		if cur := existing[x.Name]; cur != nil {
			if !in.Overwrite {
				skipped = append(skipped, x.Name)
				continue
			}
			if old, err := s.openVersion(r, cur, cur.CurrentVersion); err == nil && old == x.Value {
				unchanged = append(unchanged, x.Name)
				continue
			}
			ct, wrapped, err := s.keys.Seal([]byte(x.Value), secretAAD(cur.ID, cur.CurrentVersion+1))
			if err != nil {
				s.internalError(w, r, err)
				return
			}
			nv := &store.NewVersion{PrevVersion: cur.CurrentVersion, Ciphertext: ct, WrappedKey: wrapped}
			if _, err := s.store.UpdateSecret(r.Context(), cur, nv, a.user.ID); err != nil {
				s.internalError(w, r, err)
				return
			}
			updated = append(updated, x.Name)
			continue
		}
		sec := &store.Secret{ID: crypto.NewUUID(), ProjectID: env.ProjectID, EnvironmentID: env.ID, Name: x.Name,
			Tags: []string{}, CustomFields: map[string]string{}}
		sec.ServiceID = idOrNil(svc)
		ct, wrapped, err := s.keys.Seal([]byte(x.Value), secretAAD(sec.ID, 1))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if _, err := s.store.CreateSecret(r.Context(), sec, ct, wrapped, a.user.ID); err != nil {
			if errors.Is(err, store.ErrConflict) { // someone added it in the meantime
				skipped = append(skipped, x.Name)
				continue
			}
			s.internalError(w, r, err)
			return
		}
		created = append(created, x.Name)
	}
	sort.Strings(created)
	sort.Strings(updated)
	svcKey := ""
	if svc != nil {
		svcKey = svc.Key
	}
	// One summary entry (names only — never values).
	keys, _ := s.store.ProjectKeysByIDs(r.Context(), []string{env.ProjectID})
	s.audit(r, a, "secret.bulk_import", "environment", env.ID, map[string]any{
		"project": keys[env.ProjectID], "environment": env.Name, "service": svcKey, "overwrite": in.Overwrite,
		"created": created, "updated": updated, "unchanged": len(unchanged), "skipped": skipped,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"created": len(created), "updated": len(updated), "unchanged": len(unchanged), "skipped": skipped,
	})
}

// handleDeleteAllSecrets removes every secret in an environment (within a service
// scope), with their history. Owner and admin only, and the caller has to send the
// environment's name back as confirmation — so a stray request can't do it.
func (s *Server) handleDeleteAllSecrets(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	env, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	var in struct {
		Service string `json:"service"` // "" = every secret in the environment, "-" = the project's own, or a service ID
		Confirm string `json:"confirm"` // must equal the environment's name
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Confirm != env.Name {
		writeError(w, http.StatusBadRequest, "type the environment's name to confirm")
		return
	}
	scope := store.ScopeFilter(in.Service)
	if !scope.Valid() {
		writeError(w, http.StatusBadRequest, "service must be an ID or '-' (the project itself)")
		return
	}
	if scope != "" && scope != store.ScopeNone {
		if _, _, err := s.resolveScope(r, env.ProjectID, &in.Service, nil); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	names, err := s.store.DeleteSecretsInScope(r.Context(), env.ID, scope)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	keys, _ := s.store.ProjectKeysByIDs(r.Context(), []string{env.ProjectID})
	s.audit(r, a, "secret.delete_all", "environment", env.ID, map[string]any{
		"project": keys[env.ProjectID], "environment": env.Name, "scope": in.Service, "count": len(names), "names": names,
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": len(names)})
}
