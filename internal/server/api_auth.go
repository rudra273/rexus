package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

// API tokens look like rxt_… so a leaked one is easy to recognise (and for
// secret scanners to flag). The part after the prefix is 256 random bits.
const (
	tokenPrefix        = "rxt_"
	tokenRatePerMinute = 300
	maxActiveTokens    = 50
	usageAuditEvery    = 10 * time.Minute
)

// newToken returns a new token and the short prefix shown in the UI.
func newToken() (token, prefix string) {
	token = tokenPrefix + crypto.RandomToken(32)
	return token, token[:8]
}

// bearerToken reads "Authorization: Bearer rxt_…". present says whether a
// bearer credential was sent at all; ok whether it has the shape of a token.
func bearerToken(r *http.Request) (token string, present, ok bool) {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) < 7 || !strings.EqualFold(h[:6], "bearer") || (len(h) > 6 && h[6] != ' ') {
		return "", false, false
	}
	token = strings.TrimSpace(h[6:])
	return token, true, strings.HasPrefix(token, tokenPrefix) && len(token) <= 100
}

// rateLimiter is a fixed-window request counter, one window per key.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	m      map[string]*rateEntry
}

type rateEntry struct {
	start time.Time
	n     int
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, m: map[string]*rateEntry{}}
}

// Allow counts one request. It reports whether it is allowed, how many
// requests are left in this window, and how long until the window resets.
func (l *rateLimiter) Allow(key string, now time.Time) (ok bool, remaining int, resetIn time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.m[key]
	if e == nil || now.Sub(e.start) >= l.window {
		if len(l.m) > 5000 {
			for k, v := range l.m {
				if now.Sub(v.start) >= l.window {
					delete(l.m, k)
				}
			}
		}
		e = &rateEntry{start: now}
		l.m[key] = e
	}
	resetIn = l.window - now.Sub(e.start)
	if e.n >= l.limit {
		return false, 0, resetIn
	}
	e.n++
	return true, l.limit - e.n, resetIn
}

type tokenHandler func(w http.ResponseWriter, r *http.Request, t *store.APIToken)

// apiToken guards the public API: it accepts only an API token — never a
// browser session — and refuses revoked, expired or unknown tokens.
func (s *Server) apiToken(h tokenHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		unauthorized := func(msg string) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="rexus"`)
			writeError(w, http.StatusUnauthorized, msg)
		}
		if s.tokenFails.Blocked(ip) {
			w.Header().Set("Retry-After", "900")
			writeError(w, http.StatusTooManyRequests, "too many invalid API tokens from this address — try again in 15 minutes")
			return
		}
		raw, present, shaped := bearerToken(r)
		if !present {
			unauthorized("missing API token — send the header 'Authorization: Bearer <token>'")
			return
		}
		if !shaped {
			s.tokenFails.Fail(ip)
			unauthorized("invalid, expired or revoked API token")
			return
		}
		t, err := s.store.TokenByHash(r.Context(), crypto.HashToken(raw))
		if err != nil {
			if err == store.ErrNotFound {
				s.tokenFails.Fail(ip)
				unauthorized("invalid, expired or revoked API token")
				return
			}
			s.internalError(w, r, err)
			return
		}
		// Lockdown: only the owner may use Rexus — that includes the tools acting for the team.
		if s.cfg.LoginOwnerOnly {
			writeError(w, http.StatusForbidden, "Rexus is in lockdown mode: API tokens are disabled")
			return
		}
		ok, remaining, resetIn := s.tokenRate.Allow(t.ID, time.Now())
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(tokenRatePerMinute))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(resetIn.Seconds())+1))
			writeError(w, http.StatusTooManyRequests, fmt.Sprintf("rate limit exceeded: %d requests per minute per token", tokenRatePerMinute))
			return
		}
		s.store.TouchToken(r.Context(), t.ID, ip)
		s.noteUse(r, t, ip)
		h(w, r, t)
	}
}

// noteUse writes a "token.use" audit entry at most every 10 minutes per token
// and address, with the number of requests since the last one. Anything that
// reads a secret value, or changes something, is audited every time on its own.
func (s *Server) noteUse(r *http.Request, t *store.APIToken, ip string) {
	key := t.ID + "|" + ip
	s.useMu.Lock()
	n := s.useNotes[key]
	if n == nil {
		if len(s.useNotes) > 5000 {
			s.useNotes = map[string]*useNote{}
		}
		n = &useNote{}
		s.useNotes[key] = n
	}
	n.count++
	due := n.last.IsZero() || time.Since(n.last) >= usageAuditEvery
	count := n.count
	if due {
		n.last, n.count = time.Now(), 0
	}
	s.useMu.Unlock()
	if due {
		s.auditToken(r, t, "token.use", "api_token", t.ID, map[string]any{"requests": count, "first_path": r.URL.Path})
	}
}

type useNote struct {
	last  time.Time
	count int
}

// auditToken records an action done through an API token. The actor shows up
// as "token:<name>" in the audit log.
func (s *Server) auditToken(r *http.Request, t *store.APIToken, action, targetType, targetID string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	details["token_id"] = t.ID
	details["role"] = t.Role
	s.store.Audit(r.Context(), store.AuditEntry{
		Actor: "token:" + t.Name, Action: action, TargetType: targetType, TargetID: targetID, IP: clientIP(r), Details: details,
	})
}
