package server

import (
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
	return e, true
}

func (s *Server) handleListEnvironments(w http.ResponseWriter, r *http.Request, a *authCtx) {
	p, err := s.store.ProjectByKey(r.Context(), r.PathValue("key"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
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
	if !requireWrite(w, a) {
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
	if !requireWrite(w, a) {
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
	if err := s.store.DeleteEnvironment(r.Context(), e.ID); err != nil {
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
	return sec, true
}

func secretTarget(sec *store.Secret) map[string]any {
	return map[string]any{"name": sec.Name, "project": sec.ProjectKey, "environment": sec.EnvironmentName}
}

func (s *Server) handleListSecrets(w http.ResponseWriter, r *http.Request, a *authCtx) {
	q := r.URL.Query()
	f := store.SecretFilter{Query: q.Get("q"), Tag: strings.TrimSpace(q.Get("tag"))}
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
	sec := &store.Secret{ID: crypto.NewUUID(), EnvironmentID: env.ID}
	if err := in.applyMeta(sec); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
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
		writeError(w, http.StatusConflict, "this environment already has a secret named '"+sec.Name+"'")
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
		writeError(w, http.StatusConflict, "this environment already has a secret named '"+sec.Name+"'")
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

// handleRevealSecret decrypts one version. It is the only place a secret
// value leaves the server, and every call is audit-logged (reveal or copy).
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
