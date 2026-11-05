package server

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

// ---- managing deploy tokens (browser, Vault page → project → Deploy tokens) ----

// handleListDeployTokens lists deploy tokens — every role may see them (names,
// scope, last use), never the tokens themselves. ?project=<key> narrows it.
func (s *Server) handleListDeployTokens(w http.ResponseWriter, r *http.Request, a *authCtx) {
	projectID := ""
	if key := strings.TrimSpace(r.URL.Query().Get("project")); key != "" {
		p, err := s.store.ProjectByKey(r.Context(), key)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		projectID = p.ID
	}
	tokens, err := s.store.ListTokens(r.Context(), store.TokenKindDeploy, projectID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": tokens, "max": maxDeployTokens, "url": s.cfg.BaseURL})
}

// handleCreateDeployToken makes a token that can read one project + environment
// (+ optional service) — and nothing else. Whoever can reveal secrets may do it.
func (s *Server) handleCreateDeployToken(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireWrite(w, a) {
		return
	}
	if !s.cfg.ModuleVault {
		writeError(w, http.StatusNotFound, "the vault module is disabled on this Rexus")
		return
	}
	var in struct {
		Name          string `json:"name"`
		Project       string `json:"project"`     // project key
		Environment   string `json:"environment"` // environment name
		Service       string `json:"service"`     // service key; "" = the project's own secrets
		ExpiresInDays *int   `json:"expires_in_days"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := validChannelName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	p, err := s.store.ProjectByKey(r.Context(), in.Project)
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
	var envID, envName string
	for _, e := range envs {
		if e.Name == strings.ToLower(strings.TrimSpace(in.Environment)) {
			envID, envName = e.ID, e.Name
		}
	}
	if envID == "" {
		writeError(w, http.StatusBadRequest, "choose an environment of this project")
		return
	}
	var serviceID *string
	serviceKey := ""
	if k := strings.TrimSpace(in.Service); k != "" {
		sv, err := s.store.ServiceByKey(r.Context(), p.ID, k)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusBadRequest, "that service doesn't exist in this project")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		serviceID, serviceKey = &sv.ID, sv.Key
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
	if n, err := s.store.CountActiveTokens(r.Context(), store.TokenKindDeploy); err != nil {
		s.internalError(w, r, err)
		return
	} else if n >= maxDeployTokens {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d active deploy tokens — revoke one you no longer use", maxDeployTokens))
		return
	}

	token, prefix := newToken()
	t, err := s.store.CreateDeployToken(r.Context(), name, prefix, crypto.HashToken(token), a.user.ID, p.ID, serviceID, envID, expires)
	if err != nil {
		if errors.Is(err, store.ErrInvalidScope) {
			writeError(w, http.StatusBadRequest, "the service or environment doesn't belong to this project")
			return
		}
		s.internalError(w, r, err)
		return
	}
	details := map[string]any{"name": t.Name, "kind": "deploy", "prefix": t.Prefix, "project": p.Key,
		"environment": envName, "service": serviceKey, "expires": "never"}
	if expires != nil {
		details["expires"] = expires.UTC().Format("2006-01-02")
	}
	s.audit(r, a, "token.create", "api_token", t.ID, details)
	// The only time the token itself is ever returned.
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "meta": t, "url": s.cfg.BaseURL})
}

// ---- GET /api/v1/env (deploy tokens only) ----

// envMaxSecrets is a safety cap: one scope never legitimately holds this many.
const envMaxSecrets = 500

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// handleV1Env returns the current value of every secret in the token's scope
// — nothing else (no notes, tags or history). ?format=json for JSON; the
// default is a .env file. Every call is audited.
func (s *Server) handleV1Env(w http.ResponseWriter, r *http.Request, t *store.APIToken) {
	if !s.v1NeedVault(w) {
		return
	}
	format := r.URL.Query().Get("format")
	if format != "" && format != "dotenv" && format != "json" {
		writeError(w, http.StatusBadRequest, "format must be dotenv (default) or json")
		return
	}
	if t.ProjectID == nil || t.EnvironmentID == nil { // the database forbids it; never fail open
		writeError(w, http.StatusForbidden, "this deploy token has no scope")
		return
	}
	svc := store.ScopeNone // the project's own secrets
	if t.ServiceID != nil {
		svc = store.ScopeFilter(*t.ServiceID)
	}
	secrets, err := s.store.ListSecrets(r.Context(), store.SecretFilter{ProjectID: *t.ProjectID, EnvironmentID: *t.EnvironmentID, Service: svc})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(secrets) >= envMaxSecrets {
		writeError(w, http.StatusInternalServerError, "this scope holds too many secrets to export")
		return
	}
	values := make(map[string]string, len(secrets))
	for _, sec := range secrets {
		v, err := s.openVersion(r, sec, sec.CurrentVersion)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		values[sec.Name] = v
	}
	s.auditToken(r, t, "env.fetch", "api_token", t.ID, map[string]any{
		"project": strOr(t.ProjectKey, ""), "service": strOr(t.ServiceKey, ""), "environment": strOr(t.EnvironmentName, ""),
		"secrets": len(values), "format": firstNonEmpty(format, "dotenv"),
	})

	w.Header().Set("Cache-Control", "no-store")
	if format == "json" {
		writeJSON(w, http.StatusOK, values)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(renderDotenv(values)))
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// renderDotenv writes one line per secret, sorted by name. Names that aren't
// valid variable names are left out and noted in a comment.
func renderDotenv(values map[string]string) string {
	names := make([]string, 0, len(values))
	for n := range values {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	var skipped []string
	for _, n := range names {
		if !envNameRE.MatchString(n) {
			skipped = append(skipped, n)
			continue
		}
		b.WriteString(dotenvLine(n, values[n]))
		b.WriteByte('\n')
	}
	for _, n := range skipped {
		fmt.Fprintf(&b, "# skipped %q: not a valid variable name\n", n)
	}
	return b.String()
}

// dotenvLine picks the quoting that the common .env parsers (Node's
// --env-file, the dotenv packages, Docker Compose) all read the same way —
// their handling of backslash escapes differs, only \n is universal:
//
//  1. Single quotes, taken literally everywhere: used whenever the value has
//     no apostrophe or line break. Covers nearly every secret, including
//     ones with ", $, # and \.
//  2. Double quotes with \n for line breaks (private keys, certificates),
//     when the value has no ", $ or \ that would need an escape.
//  3. Otherwise double quotes with full escaping. Docker Compose and
//     python-dotenv read that exactly; for any parser, ?format=json is exact.
func dotenvLine(name, v string) string {
	switch {
	case !strings.ContainsAny(v, "'\r\n"):
		return name + "='" + v + "'"
	case !strings.ContainsAny(v, "\"\\$"):
		return name + `="` + dotenvLineBreaks.Replace(v) + `"`
	default:
		return name + `="` + dotenvEscaper.Replace(v) + `"`
	}
}

var (
	dotenvLineBreaks = strings.NewReplacer("\n", `\n`, "\r", `\r`)
	dotenvEscaper    = strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`, "\n", `\n`, "\r", `\r`)
)
