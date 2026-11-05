// Package server is the HTTP API + embedded web UI.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"path"
	"strings"
	"sync"
	"time"

	"rexus/internal/alerts"
	"rexus/internal/auth"
	"rexus/internal/backup"
	"rexus/internal/config"
	"rexus/internal/crypto"
	"rexus/internal/scheduler"
	"rexus/internal/store"
	"rexus/web"
)

type Server struct {
	cfg     *config.Config
	store   *store.Store
	keys    *crypto.Keyring
	engine  *scheduler.Engine
	alerts  *alerts.Service
	backups *backup.Service
	log     *slog.Logger
	version string

	setupMu   sync.Mutex
	setupCode string // in memory only; empty once an owner exists

	loginLimiter *auth.Limiter // per IP and per email
	mfaLimiter   *auth.Limiter // per user
	setupLimiter *auth.Limiter // per IP
	linkLimiter  *auth.Limiter // bad invite/reset tokens, per IP

	// Public API (/api/v1)
	tokenFails *auth.Limiter // invalid API tokens, per IP
	tokenRate  *rateLimiter  // requests per minute, per token
	useMu      sync.Mutex
	useNotes   map[string]*useNote
}

func New(cfg *config.Config, st *store.Store, keys *crypto.Keyring, engine *scheduler.Engine, al *alerts.Service, bk *backup.Service, log *slog.Logger, version string) *Server {
	return &Server{
		cfg:          cfg,
		store:        st,
		keys:         keys,
		engine:       engine,
		alerts:       al,
		backups:      bk,
		log:          log,
		version:      version,
		loginLimiter: auth.NewLimiter(5, 15*time.Minute),
		mfaLimiter:   auth.NewLimiter(5, 15*time.Minute),
		setupLimiter: auth.NewLimiter(10, 15*time.Minute),
		linkLimiter:  auth.NewLimiter(20, 15*time.Minute),
		tokenFails:   auth.NewLimiter(20, 15*time.Minute),
		tokenRate:    newRateLimiter(tokenRatePerMinute, time.Minute),
		useNotes:     map[string]*useNote{},
	}
}

// InitSetup decides setup mode vs normal mode by asking the database whether
// an owner exists. In setup mode a one-time code is printed to the logs.
func (s *Server) InitSetup(ctx context.Context) error {
	exists, err := s.store.OwnerExists(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	code := newSetupCode()
	s.setupMu.Lock()
	s.setupCode = code
	s.setupMu.Unlock()

	banner := strings.Repeat("=", 60)
	fmt.Printf("\n%s\n  REXUS SETUP MODE — no owner exists yet\n\n  Open %s/setup and enter this one-time setup code:\n\n      %s\n\n  Or create the owner from the CLI:  rexus owner create --email you@company.com\n%s\n\n",
		banner, s.cfg.BaseURL, code, banner)
	return nil
}

func (s *Server) checkSetupCode(given string) bool {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.setupCode == "" {
		return false
	}
	norm := func(v string) string {
		return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(v)))
	}
	return subtle.ConstantTimeCompare([]byte(norm(given)), []byte(norm(s.setupCode))) == 1
}

func (s *Server) clearSetupCode() {
	s.setupMu.Lock()
	s.setupCode = ""
	s.setupMu.Unlock()
}

// Handler builds the full HTTP handler: API routes, embedded UI, middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/meta", s.handleMeta)
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("GET /api/setup/backups", s.handleSetupBackups)
	mux.HandleFunc("POST /api/setup/restore", s.handleSetupRestore)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	// Invite and password-reset links (the token in the URL is the credential).
	mux.HandleFunc("GET /api/join/{token}", s.handleJoinInfo)
	mux.HandleFunc("POST /api/join/{token}", s.handleJoinAccept)
	mux.HandleFunc("GET /api/reset/{token}", s.handleResetInfo)
	mux.HandleFunc("POST /api/reset/{token}", s.handleResetUse)

	// Session exists, 2FA may still be pending
	mux.HandleFunc("GET /api/auth/me", s.partial(s.handleMe))
	mux.HandleFunc("POST /api/auth/logout", s.partial(s.handleLogout))
	mux.HandleFunc("POST /api/auth/2fa/verify", s.partial(s.handle2FAVerify))
	mux.HandleFunc("POST /api/auth/2fa/setup", s.partial(s.handle2FASetup))
	mux.HandleFunc("POST /api/auth/2fa/enable", s.partial(s.handle2FAEnable))

	// Fully authenticated
	mux.HandleFunc("POST /api/auth/2fa/disable", s.authed(s.handle2FADisable))
	mux.HandleFunc("POST /api/auth/password", s.authed(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/logout-all", s.authed(s.handleLogoutAll))
	mux.HandleFunc("GET /api/settings", s.authed(s.handleSettings))

	// Team (owner / admin; checked inside each handler)
	mux.HandleFunc("GET /api/users", s.authed(s.handleListUsers))
	mux.HandleFunc("PATCH /api/users/{id}", s.authed(s.handleUpdateUser))
	mux.HandleFunc("DELETE /api/users/{id}", s.authed(s.handleDeleteUser))
	mux.HandleFunc("POST /api/users/{id}/reset-password", s.authed(s.handleResetPasswordLink))
	mux.HandleFunc("POST /api/users/{id}/reset-2fa", s.authed(s.handleReset2FA))
	mux.HandleFunc("GET /api/invites", s.authed(s.handleListInvites))
	mux.HandleFunc("POST /api/invites", s.authed(s.handleCreateInvite))
	mux.HandleFunc("DELETE /api/invites/{id}", s.authed(s.handleRevokeInvite))
	mux.HandleFunc("POST /api/owner/transfer", s.authed(s.handleTransferOwnership))
	mux.HandleFunc("GET /api/audit", s.authed(s.handleAudit))

	// Backups (owner / admin; 404 unless REXUS_BACKUP_ENABLED)
	mux.HandleFunc("GET /api/backups", s.authed(s.handleListBackups))
	mux.HandleFunc("GET /api/backups/status", s.authed(s.handleBackupStatus))
	mux.HandleFunc("POST /api/backups/run", s.authed(s.handleRunBackup))
	mux.HandleFunc("PUT /api/backups/settings", s.authed(s.handleBackupSettings))

	// API tokens (owner / admin)
	mux.HandleFunc("GET /api/tokens", s.authed(s.handleListTokens))
	mux.HandleFunc("POST /api/tokens", s.authed(s.handleCreateToken))
	mux.HandleFunc("DELETE /api/tokens/{id}", s.authed(s.handleRevokeToken))
	mux.HandleFunc("GET /api/deploy-tokens", s.authed(s.handleListDeployTokens))
	mux.HandleFunc("POST /api/deploy-tokens", s.authed(s.handleCreateDeployToken))

	// Public API for other tools: API token only, never a browser session.
	mux.HandleFunc("GET /api/v1/health", s.anyToken(s.handleV1Health))
	mux.HandleFunc("GET /api/v1/env", s.deployToken(s.handleV1Env))
	mux.HandleFunc("GET /api/v1/projects", s.apiToken(s.handleV1Projects))
	mux.HandleFunc("GET /api/v1/projects/{key}", s.apiToken(s.handleV1Project))
	mux.HandleFunc("GET /api/v1/projects/{key}/status", s.apiToken(s.handleV1Status))
	mux.HandleFunc("GET /api/v1/projects/{key}/checks", s.apiToken(s.handleV1Checks))
	mux.HandleFunc("GET /api/v1/projects/{key}/jobs", s.apiToken(s.handleV1Jobs))
	mux.HandleFunc("GET /api/v1/projects/{key}/secrets", s.apiToken(s.handleV1ProjectSecrets))
	mux.HandleFunc("GET /api/v1/projects/{key}/secrets/{env}/{name}", s.apiToken(s.handleV1Secret))
	mux.HandleFunc("POST /api/v1/projects/{key}/secrets/{env}/{name}/reveal", s.apiToken(s.handleV1Reveal))
	mux.HandleFunc("GET /api/v1/projects/{key}/services", s.apiToken(s.handleV1Services))
	mux.HandleFunc("GET /api/v1/projects/{key}/services/{service}/secrets/{env}/{name}", s.apiToken(s.handleV1Secret))
	mux.HandleFunc("POST /api/v1/projects/{key}/services/{service}/secrets/{env}/{name}/reveal", s.apiToken(s.handleV1Reveal))
	mux.HandleFunc("GET /api/v1/secrets/expiring", s.apiToken(s.handleV1Expiring))

	// Alerts (owner / admin)
	mux.HandleFunc("GET /api/alerts/channels", s.authed(s.handleListChannels))
	mux.HandleFunc("POST /api/alerts/channels", s.authed(s.handleCreateChannel))
	mux.HandleFunc("PUT /api/alerts/channels/{id}", s.authed(s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/alerts/channels/{id}", s.authed(s.handleDeleteChannel))
	mux.HandleFunc("POST /api/alerts/channels/{id}/test", s.authed(s.handleTestChannel))
	mux.HandleFunc("GET /api/alerts/events", s.authed(s.handleListAlertEvents))
	mux.HandleFunc("PUT /api/alerts/events/{key}", s.authed(s.handleUpdateAlertEvent))
	mux.HandleFunc("GET /api/alerts/history", s.authed(s.handleAlertHistory))

	mux.HandleFunc("GET /api/projects", s.authed(s.handleListProjects))
	mux.HandleFunc("POST /api/projects", s.authed(s.handleCreateProject))
	mux.HandleFunc("GET /api/projects/{key}", s.authed(s.handleGetProject))
	mux.HandleFunc("PATCH /api/projects/{key}", s.authed(s.handleUpdateProject))
	mux.HandleFunc("DELETE /api/projects/{key}", s.authed(s.handleDeleteProject))
	mux.HandleFunc("GET /api/projects/{key}/access", s.authed(s.handleGetProjectAccess))
	mux.HandleFunc("PUT /api/projects/{key}/access", s.authed(s.handleSetProjectAccess))

	// Services: optional groups inside a project (shared by every module)
	mux.HandleFunc("GET /api/projects/{key}/services", s.authed(s.handleListServices))
	mux.HandleFunc("POST /api/projects/{key}/services", s.authed(s.handleCreateService))
	mux.HandleFunc("PATCH /api/services/{id}", s.authed(s.handleUpdateService))
	mux.HandleFunc("DELETE /api/services/{id}", s.authed(s.handleDeleteService))

	// Health checks (system jobs: always on, regardless of the scheduler module)
	mux.HandleFunc("GET /api/checks", s.authed(s.handleListChecks))
	mux.HandleFunc("GET /api/checks/series", s.authed(s.handleAllChecksSeries))
	mux.HandleFunc("GET /api/projects/{key}/checks", s.authed(s.handleListProjectChecks))
	mux.HandleFunc("POST /api/projects/{key}/checks", s.authed(s.handleCreateCheck))
	mux.HandleFunc("GET /api/checks/{id}", s.authed(s.handleGetCheck))
	mux.HandleFunc("PUT /api/checks/{id}", s.authed(s.handleUpdateCheck))
	mux.HandleFunc("DELETE /api/checks/{id}", s.authed(s.handleDeleteCheck))
	mux.HandleFunc("POST /api/checks/{id}/run", s.authed(s.handleRunCheck))
	mux.HandleFunc("GET /api/checks/{id}/series", s.authed(s.handleCheckSeries))

	if s.cfg.ModuleScheduler {
		mux.HandleFunc("GET /api/jobs", s.authed(s.handleListJobs))
		mux.HandleFunc("POST /api/jobs", s.authed(s.handleCreateJob))
		mux.HandleFunc("GET /api/jobs/{id}", s.authed(s.handleGetJob))
		mux.HandleFunc("PUT /api/jobs/{id}", s.authed(s.handleUpdateJob))
		mux.HandleFunc("DELETE /api/jobs/{id}", s.authed(s.handleDeleteJob))
		mux.HandleFunc("POST /api/jobs/{id}/run", s.authed(s.handleRunJob))
		mux.HandleFunc("GET /api/jobs/{id}/runs", s.authed(s.handleListRuns))
		mux.HandleFunc("GET /api/schedule/preview", s.authed(s.handleSchedulePreview))
	}

	if s.cfg.ModuleVault {
		mux.HandleFunc("GET /api/projects/{key}/environments", s.authed(s.handleListEnvironments))
		mux.HandleFunc("POST /api/projects/{key}/environments", s.authed(s.handleCreateEnvironment))
		mux.HandleFunc("PATCH /api/environments/{id}", s.authed(s.handleRenameEnvironment))
		mux.HandleFunc("DELETE /api/environments/{id}", s.authed(s.handleDeleteEnvironment))
		mux.HandleFunc("POST /api/environments/{id}/secrets", s.authed(s.handleCreateSecret))
		mux.HandleFunc("POST /api/environments/{id}/secrets/bulk", s.authed(s.handleBulkSecrets))
		mux.HandleFunc("POST /api/environments/{id}/secrets/delete-all", s.authed(s.handleDeleteAllSecrets))

		mux.HandleFunc("GET /api/secrets", s.authed(s.handleListSecrets))
		mux.HandleFunc("GET /api/secrets/{id}", s.authed(s.handleGetSecret))
		mux.HandleFunc("PATCH /api/secrets/{id}", s.authed(s.handleUpdateSecret))
		mux.HandleFunc("DELETE /api/secrets/{id}", s.authed(s.handleDeleteSecret))
		mux.HandleFunc("POST /api/secrets/{id}/reveal", s.authed(s.handleRevealSecret))
		mux.HandleFunc("GET /api/secrets/{id}/versions", s.authed(s.handleListVersions))
		mux.HandleFunc("POST /api/secrets/{id}/restore", s.authed(s.handleRestoreSecret))
		mux.HandleFunc("POST /api/secrets/{id}/move", s.authed(s.handleMoveSecret))
	}

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	mux.Handle("/", s.spaHandler())

	return s.recoverer(s.securityHeaders(s.ipGate(s.csrf(s.limitBody(mux)))))
}

// ipGate enforces REXUS_IP_ALLOWLIST. Loopback is always allowed so the
// container health check and local tools keep working.
func (s *Server) ipGate(next http.Handler) http.Handler {
	if s.cfg.IPAllowlist == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip, err := netip.ParseAddr(clientIP(r)); err == nil {
			if ip.IsLoopback() {
				next.ServeHTTP(w, r)
				return
			}
			for _, p := range s.cfg.IPAllowlist {
				if p.Contains(ip) {
					next.ServeHTTP(w, r)
					return
				}
			}
		}
		s.log.Debug("blocked by IP allowlist", "ip", clientIP(r), "path", r.URL.Path)
		http.Error(w, "access from your IP address is not allowed", http.StatusForbidden)
	})
}

// ---- middleware ----

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic", "err", rec, "path", r.URL.Path)
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		if s.cfg.SecureCookies() {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// csrf requires a custom header on state-changing API calls. Browsers can't
// send custom headers cross-site without a CORS preflight, which Rexus never
// allows — combined with SameSite cookies this blocks CSRF.
func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /api/v1 takes a bearer token, which a browser never attaches by itself,
		// so there is nothing for a cross-site request to forge.
		if strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/api/v1/") {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
			default:
				if r.Header.Get("X-Rexus-Request") != "1" {
					writeError(w, http.StatusForbidden, "missing X-Rexus-Request header")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		next.ServeHTTP(w, r)
	})
}

// ---- static UI ----

func (s *Server) spaHandler() http.Handler {
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" {
			if st, err := fs.Stat(dist, p); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// SPA fallback: every unknown path renders index.html.
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "Rexus UI is not built. Run `make build` (or `cd web && npm run build`) and restart.")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	return true
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

// clientIP returns the visitor's IP. Behind a local proxy or tunnel
// (cloudflared, Tailscale serve, Docker's network) the TCP peer is the proxy
// itself, so the proxy's header is used — but only when the peer is loopback or
// a private address. A direct connection from the internet can't spoof it.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if peer.IsLoopback() || peer.IsPrivate() {
		if v := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); v != "" {
			if a, err := netip.ParseAddr(v); err == nil {
				return a.Unmap().String()
			}
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			// The rightmost entry is the one our own proxy appended.
			if a, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				return a.Unmap().String()
			}
		}
	}
	return peer.String()
}

func newSetupCode() string {
	// Crockford-style alphabet without look-alike characters.
	// 12 chars from 30 symbols ≈ 59 bits — plenty with the setup rate limit.
	const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	var b strings.Builder
	n := 0
	buf := make([]byte, 1)
	for n < 12 {
		if _, err := rand.Read(buf); err != nil {
			panic(err)
		}
		if int(buf[0]) >= 240 { // reject to avoid modulo bias (240 = 8*30)
			continue
		}
		if n > 0 && n%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(alphabet[int(buf[0])%len(alphabet)])
		n++
	}
	return b.String()
}
