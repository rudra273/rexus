package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

const (
	maxSecretValue  = 64 * 1024
	maxNotes        = 5000
	maxTags         = 20
	maxCustomFields = 20
)

var (
	secretNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
	tagRe        = regexp.MustCompile(`^[a-z0-9][a-z0-9_.:-]{0,29}$`)
)

// secretAAD ties a ciphertext to one specific secret version.
func secretAAD(secretID string, version int) []byte { return crypto.SecretAAD(secretID, version) }

type secretInput struct {
	Name         string            `json:"name"`
	Value        *string           `json:"value"` // required on create; on update only if the value changes
	ExpiresOn    *string           `json:"expires_on"`
	Notes        string            `json:"notes"`
	Tags         []string          `json:"tags"`
	CustomFields map[string]string `json:"custom_fields"`
	// ServiceID is only read on create (nil/"" = the project directly).
	// Changing it later is an explicit move: POST /api/secrets/{id}/move.
	ServiceID *string `json:"service_id"`
}

// applyMeta validates the non-value fields and copies them onto sec.
func (in *secretInput) applyMeta(sec *store.Secret) error {
	name := strings.TrimSpace(in.Name)
	if !secretNameRe.MatchString(name) {
		return errors.New("secret name must be 1–100 characters: letters, numbers, dots, dashes and underscores (e.g. STRIPE_KEY)")
	}
	sec.Name = name

	sec.ExpiresOn = nil
	if in.ExpiresOn != nil && strings.TrimSpace(*in.ExpiresOn) != "" {
		d := strings.TrimSpace(*in.ExpiresOn)
		if _, err := time.Parse("2006-01-02", d); err != nil {
			return errors.New("expiry must be a date like 2026-12-31")
		}
		sec.ExpiresOn = &d
	}

	notes := strings.TrimSpace(in.Notes)
	if utf8.RuneCountInString(notes) > maxNotes {
		return fmt.Errorf("notes must be at most %d characters", maxNotes)
	}
	sec.Notes = notes

	tags := []string{}
	seen := map[string]bool{}
	for _, t := range in.Tags {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		if !tagRe.MatchString(t) {
			return fmt.Errorf("invalid tag %q: use lowercase letters, numbers, dots, dashes, colons or underscores (max 30)", t)
		}
		seen[t] = true
		tags = append(tags, t)
	}
	if len(tags) > maxTags {
		return fmt.Errorf("at most %d tags", maxTags)
	}
	sec.Tags = tags

	fields := map[string]string{}
	for k, v := range in.CustomFields {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if utf8.RuneCountInString(k) > 50 || utf8.RuneCountInString(v) > 500 {
			return errors.New("custom field names are limited to 50 characters and values to 500")
		}
		fields[k] = v
	}
	if len(fields) > maxCustomFields {
		return fmt.Errorf("at most %d custom fields", maxCustomFields)
	}
	sec.CustomFields = fields
	return nil
}

func validateValue(v string) error {
	if v == "" {
		return errors.New("value is required")
	}
	if len(v) > maxSecretValue {
		return fmt.Errorf("value must be at most %d KB", maxSecretValue/1024)
	}
	return nil
}

// secretView hides notes and custom fields from read-only roles: Viewers see
// names, expiry and tags, but nothing else (plan.md §5).
func secretView(sec *store.Secret, a *authCtx) *store.Secret {
	if !canWrite(a.user.Role) {
		sec.Notes = ""
		sec.CustomFields = map[string]string{}
	}
	return sec
}

// ---- environments ----

func (s *Server) loadEnv(w http.ResponseWriter, r *http.Request) (*store.Environment, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "environment not found")
		return nil, false
	}
	e, err := s.store.EnvironmentByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "environment not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	if !s.visible(w, r, e.ProjectID, "environment not found") {
		return nil, false
	}
	return e, true
}

func (s *Server) handleListEnvironments(w http.ResponseWriter, r *http.Request, a *authCtx) {
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	envs, err := s.store.ListEnvironments(r.Context(), p.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": envs})
}

func (s *Server) handleCreateEnvironment(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	p, ok := s.loadProject(w, r)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := store.NormalizeEnvName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	e, err := s.store.CreateEnvironment(r.Context(), p.ID, name)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "this project already has an environment named '"+name+"'")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "environment.create", "environment", e.ID, map[string]any{"project": p.Key, "name": name})
	writeJSON(w, http.StatusCreated, map[string]any{"environment": e})
}

func (s *Server) handleRenameEnvironment(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	e, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := store.NormalizeEnvName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.RenameEnvironment(r.Context(), e.ID, name); errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "this project already has an environment named '"+name+"'")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "environment.rename", "environment", e.ID, map[string]any{"from": e.Name, "to": name})
	e.Name = name
	writeJSON(w, http.StatusOK, map[string]any{"environment": e})
}

func (s *Server) handleDeleteEnvironment(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	e, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	if e.SecretCount > 0 {
		writeError(w, http.StatusConflict, fmt.Sprintf("'%s' still has %d secret(s) — delete them first", e.Name, e.SecretCount))
		return
	}
	if err := s.store.DeleteEnvironment(r.Context(), e.ID); errors.Is(err, store.ErrInUse) {
		writeError(w, http.StatusConflict, fmt.Sprintf("'%s' is still used by jobs or health checks — change their environment first", e.Name))
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "environment.delete", "environment", e.ID, map[string]any{"name": e.Name})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- secrets ----

func (s *Server) loadSecret(w http.ResponseWriter, r *http.Request) (*store.Secret, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "secret not found")
		return nil, false
	}
	sec, err := s.store.SecretByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "secret not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	if !s.visible(w, r, sec.ProjectID, "secret not found") {
		return nil, false
	}
	return sec, true
}

func secretTarget(sec *store.Secret) map[string]any {
	return map[string]any{"name": sec.Name, "project": sec.ProjectKey, "environment": sec.EnvironmentName,
		"service": strOr(sec.ServiceKey, "")}
}

// scopeLabel names a secret's scope in messages: "the project" or "service 'api'".
func scopeLabel(serviceKey *string) string {
	if serviceKey == nil {
		return "the project"
	}
	return "service '" + *serviceKey + "'"
}

func (s *Server) handleListSecrets(w http.ResponseWriter, r *http.Request, a *authCtx) {
	q := r.URL.Query()
	svcFilter, ok := scopeFilterParam(w, r, "service")
	if !ok {
		return
	}
	f := store.SecretFilter{Query: q.Get("q"), Tag: strings.TrimSpace(q.Get("tag")), Service: svcFilter}
	if p := q.Get("project"); p != "" {
		proj, err := s.store.ProjectByKeyFor(r.Context(), s.access(r), p)
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"secrets": []any{}})
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		f.ProjectID = proj.ID
	}
	if env := q.Get("environment"); env != "" {
		if !store.IsUUID(env) {
			writeJSON(w, http.StatusOK, map[string]any{"secrets": []any{}})
			return
		}
		f.EnvironmentID = env
	}
	if v := q.Get("expiring"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 3650 {
			writeError(w, http.StatusBadRequest, "expiring must be a number of days (0–3650)")
			return
		}
		f.ExpiringDays = &n
	}
	f.Access = s.access(r)
	secrets, err := s.store.ListSecrets(r.Context(), f)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, x := range secrets {
		secretView(x, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"secrets": secrets})
}

func (s *Server) handleGetSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"secret": secretView(sec, a)})
}

func (s *Server) handleCreateSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	env, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	var in secretInput
	if !decodeJSON(w, r, &in) {
		return
	}
	sec := &store.Secret{ID: crypto.NewUUID(), ProjectID: env.ProjectID, EnvironmentID: env.ID}
	if err := in.applyMeta(sec); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	svc, _, err := s.resolveScope(r, env.ProjectID, in.ServiceID, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sec.ServiceID = idOrNil(svc)
	var svcKey *string
	if svc != nil {
		svcKey = &svc.Key
	}
	if in.Value == nil {
		writeError(w, http.StatusBadRequest, "value is required")
		return
	}
	if err := validateValue(*in.Value); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ct, wrapped, err := s.keys.Seal([]byte(*in.Value), secretAAD(sec.ID, 1))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	created, err := s.store.CreateSecret(r.Context(), sec, ct, wrapped, a.user.ID)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, fmt.Sprintf("%s already has a secret named '%s' in %s", scopeLabel(svcKey), sec.Name, env.Name))
		return
	}
	if errors.Is(err, store.ErrInvalidScope) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "secret.create", "secret", created.ID, secretTarget(created))
	writeJSON(w, http.StatusCreated, map[string]any{"secret": secretView(created, a)})
}

func (s *Server) handleUpdateSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	var in secretInput
	if !decodeJSON(w, r, &in) {
		return
	}
	oldName := sec.Name
	if err := in.applyMeta(sec); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var nv *store.NewVersion
	if in.Value != nil && *in.Value != "" {
		if err := validateValue(*in.Value); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		ct, wrapped, err := s.keys.Seal([]byte(*in.Value), secretAAD(sec.ID, sec.CurrentVersion+1))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		nv = &store.NewVersion{PrevVersion: sec.CurrentVersion, Ciphertext: ct, WrappedKey: wrapped}
	}

	updated, err := s.store.UpdateSecret(r.Context(), sec, nv, a.user.ID)
	switch {
	case errors.Is(err, store.ErrStale):
		writeError(w, http.StatusConflict, err.Error())
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, fmt.Sprintf("%s already has a secret named '%s' in %s", scopeLabel(sec.ServiceKey), sec.Name, sec.EnvironmentName))
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	details := secretTarget(updated)
	details["value_changed"] = nv != nil
	if nv != nil {
		details["version"] = updated.CurrentVersion
	}
	if oldName != updated.Name {
		details["renamed_from"] = oldName
	}
	s.audit(r, a, "secret.update", "secret", updated.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"secret": secretView(updated, a)})
}

// handleMoveSecret moves a secret between the project itself and its services
// (same project, same environment). History and encrypted values are kept.
func (s *Server) handleMoveSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	var in struct {
		ServiceID *string `json:"service_id"` // null / "" = the project directly
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	svc, _, err := s.resolveScope(r, sec.ProjectID, in.ServiceID, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to := idOrNil(svc)
	if sameID(to, sec.ServiceID) {
		writeError(w, http.StatusBadRequest, "the secret is already there")
		return
	}
	var toKey *string
	if svc != nil {
		toKey = &svc.Key
	}
	moved, err := s.store.MoveSecret(r.Context(), sec.ID, to, a.user.ID)
	switch {
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, fmt.Sprintf("%s already has a secret named '%s' in %s", scopeLabel(toKey), sec.Name, sec.EnvironmentName))
		return
	case errors.Is(err, store.ErrInvalidScope):
		writeError(w, http.StatusBadRequest, err.Error())
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	details := secretTarget(moved)
	details["from_service"] = strOr(sec.ServiceKey, "")
	s.audit(r, a, "secret.move", "secret", moved.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"secret": secretView(moved, a)})
}

func (s *Server) handleDeleteSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteSecret(r.Context(), sec.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	details := secretTarget(sec)
	details["versions"] = sec.CurrentVersion
	s.audit(r, a, "secret.delete", "secret", sec.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleCopyAllSecrets exports the latest values from one environment and service scope.
func (s *Server) handleCopyAllSecrets(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !canWrite(a.user.Role) {
		writeError(w, http.StatusForbidden, "your role can't reveal secret values")
		return
	}
	env, ok := s.loadEnv(w, r)
	if !ok {
		return
	}
	scope, ok := scopeFilterParam(w, r, "service")
	if !ok {
		return
	}
	secrets, err := s.store.ListSecrets(r.Context(), store.SecretFilter{
		EnvironmentID: env.ID, ProjectID: env.ProjectID, Service: scope, Access: s.access(r),
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(secrets) == 0 {
		writeError(w, http.StatusNotFound, "no secrets in this scope")
		return
	}
	if len(secrets) >= envMaxSecrets {
		writeError(w, http.StatusBadRequest, "too many secrets to copy at once; select a service")
		return
	}
	values := make(map[string]string, len(secrets))
	format := "dotenv"
	for _, sec := range secrets {
		if _, exists := values[sec.Name]; exists {
			writeError(w, http.StatusConflict, fmt.Sprintf("multiple secrets are named %s; select a service to copy its values", sec.Name))
			return
		}
		values[sec.Name] = ""
		if !envNameRE.MatchString(sec.Name) {
			format = "json"
		}
	}
	for _, sec := range secrets {
		value, err := s.openVersion(r, sec, sec.CurrentVersion)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		values[sec.Name] = value
	}
	var content string
	if format == "json" {
		data, err := json.MarshalIndent(values, "", "  ")
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		content = string(data)
	} else {
		content = renderDotenv(values)
	}
	s.audit(r, a, "secret.copy_all", "environment", env.ID, map[string]any{
		"project": secrets[0].ProjectKey, "environment": env.Name, "scope": scope,
		"count": len(secrets), "format": format,
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"content": content, "count": len(secrets), "format": format})
}

// handleRevealSecret decrypts one version and audit-logs the reveal or copy.
func (s *Server) handleRevealSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !canWrite(a.user.Role) {
		writeError(w, http.StatusForbidden, "your role can't reveal secret values")
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	var in struct {
		Version *int   `json:"version"`
		Purpose string `json:"purpose"` // "reveal" (default) or "copy"
	}
	if r.ContentLength != 0 && !decodeJSON(w, r, &in) {
		return
	}
	version := sec.CurrentVersion
	if in.Version != nil {
		version = *in.Version
	}
	action := "secret.reveal"
	if in.Purpose == "copy" {
		action = "secret.copy"
	}

	value, err := s.openVersion(r, sec, version)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "version not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	details := secretTarget(sec)
	details["version"] = version
	s.audit(r, a, action, "secret", sec.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"value": value, "version": version})
}

func (s *Server) openVersion(r *http.Request, sec *store.Secret, version int) (string, error) {
	ct, wrapped, err := s.store.VersionData(r.Context(), sec.ID, version)
	if err != nil {
		return "", err
	}
	pt, err := s.keys.Open(ct, wrapped, secretAAD(sec.ID, version))
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func (s *Server) handleListVersions(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !canWrite(a.user.Role) {
		writeError(w, http.StatusForbidden, "your role can't view version history")
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	versions, err := s.store.ListVersions(r.Context(), sec.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

// handleRestoreSecret copies an old value into a NEW version — history is
// never rewritten.
func (s *Server) handleRestoreSecret(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	sec, ok := s.loadSecret(w, r)
	if !ok {
		return
	}
	var in struct {
		Version int `json:"version"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Version == sec.CurrentVersion {
		writeError(w, http.StatusBadRequest, "that version is already the current value")
		return
	}
	value, err := s.openVersion(r, sec, in.Version)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "version not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	newVer := sec.CurrentVersion + 1
	ct, wrapped, err := s.keys.Seal([]byte(value), secretAAD(sec.ID, newVer))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	updated, err := s.store.UpdateSecret(r.Context(), sec,
		&store.NewVersion{PrevVersion: sec.CurrentVersion, Ciphertext: ct, WrappedKey: wrapped}, a.user.ID)
	if errors.Is(err, store.ErrStale) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	details := secretTarget(updated)
	details["restored_from"] = in.Version
	details["version"] = updated.CurrentVersion
	s.audit(r, a, "secret.restore", "secret", updated.ID, details)
	writeJSON(w, http.StatusOK, map[string]any{"secret": secretView(updated, a)})
}
