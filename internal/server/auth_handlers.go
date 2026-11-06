package server

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"rexus/internal/auth"
	"rexus/internal/crypto"
	"rexus/internal/store"
)

const (
	sessionCookie  = "rexus_session"
	partialTTL     = 10 * time.Minute // password OK, 2FA still pending
	touchThreshold = 5 * time.Minute
)

// Next-step values returned to the UI after login.
const (
	nextOK        = "ok"
	next2FAVerify = "2fa_verify"
	next2FAEnroll = "2fa_enroll"
)

type authCtx struct {
	sess *store.Session
	user *store.User
}

type authHandler func(w http.ResponseWriter, r *http.Request, a *authCtx)

func totpAAD(userID string) []byte { return crypto.TOTPAAD(userID) }

// loadSession resolves the session cookie to a live session + active user.
func (s *Server) loadSession(r *http.Request) (*authCtx, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, store.ErrNotFound
	}
	sess, u, err := s.store.SessionByToken(r.Context(), crypto.HashToken(c.Value))
	if err != nil {
		return nil, err
	}
	if u.Status != "active" {
		return nil, store.ErrNotFound
	}
	return &authCtx{sess: sess, user: u}, nil
}

// partial allows sessions whose 2FA step is still pending.
func (s *Server) partial(h authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := s.loadSession(r)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				s.internalError(w, r, err)
				return
			}
			writeError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		h(w, r, a)
	}
}

// authed requires a fully authenticated session (password + 2FA when needed).
func (s *Server) authed(h authHandler) http.HandlerFunc {
	return s.partial(func(w http.ResponseWriter, r *http.Request, a *authCtx) {
		if !a.sess.MFAVerified {
			writeError(w, http.StatusUnauthorized, "two-factor authentication required")
			return
		}
		if s.cfg.LoginOwnerOnly && a.user.Role != "owner" {
			s.store.RevokeSession(r.Context(), a.sess.ID)
			writeError(w, http.StatusForbidden, "Rexus is in lockdown mode: only the owner can log in")
			return
		}
		if time.Since(a.sess.LastSeenAt) > touchThreshold {
			s.store.TouchSession(r.Context(), a.sess.ID, time.Now().Add(s.settings.Get().SessionTTL()))
		}
		r = withReqState(r, a)
		// Only the owner sees the owner's email; for everyone else it is masked.
		if a.user.Role != "owner" {
			owner, err := s.store.Owner(r.Context())
			if err != nil {
				s.internalError(w, r, err)
				return
			}
			mw := newMaskWriter(w, owner.Email)
			h(mw, r, a)
			mw.Flush()
			return
		}
		h(w, r, a)
	})
}

func (s *Server) audit(r *http.Request, a *authCtx, action, targetType, targetID string, details map[string]any) {
	e := store.AuditEntry{Action: action, TargetType: targetType, TargetID: targetID, IP: clientIP(r), Details: details}
	// Which project the entry is about decides who may read it in the audit log.
	if pid := stateOf(r).project; pid != "" {
		e.ProjectID = &pid
	} else if targetType == "project" && store.IsUUID(targetID) {
		e.ProjectID = &targetID
	}
	if a != nil {
		e.ActorUserID = &a.user.ID
		e.Actor = a.user.Email
	} else {
		e.Actor = "anonymous"
	}
	s.store.Audit(r.Context(), e)
}

// auditProject writes an audit entry that belongs to one specific project (so it is
// only shown to people who can see that project), whatever the request touched.
func (s *Server) auditProject(r *http.Request, a *authCtx, projectID, action, targetType, targetID string, details map[string]any) {
	e := store.AuditEntry{Action: action, TargetType: targetType, TargetID: targetID, IP: clientIP(r), Details: details, ProjectID: &projectID}
	if a != nil {
		e.ActorUserID = &a.user.ID
		e.Actor = a.user.Email
	} else {
		e.Actor = "anonymous"
	}
	s.store.Audit(r.Context(), e)
}

// needsMFA reports whether a new session for u must pass a 2FA step.
func (s *Server) needsMFA(u *store.User) bool {
	if !s.cfg.TwoFAAllowed() {
		return false
	}
	return u.TOTPEnabled || s.cfg.TwoFARequiredFor(u.Role)
}

func nextStep(a *authCtx) string {
	switch {
	case a.sess.MFAVerified:
		return nextOK
	case a.user.TOTPEnabled:
		return next2FAVerify
	default:
		return next2FAEnroll
	}
}

// startSession creates a session and sets the cookie. Returns the next step
// and the new session's id.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, u *store.User) (string, string, error) {
	token := crypto.RandomToken(32)
	verified := !s.needsMFA(u)
	ttl := s.settings.Get().SessionTTL() // sliding: extended on activity
	if !verified {
		ttl = partialTTL
	}
	expires := time.Now().Add(ttl)
	sid, err := s.store.CreateSession(r.Context(), u.ID, crypto.HashToken(token), verified, clientIP(r), r.UserAgent(), expires)
	if err != nil {
		return "", "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.settings.Get().SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
	switch {
	case verified:
		return nextOK, sid, nil
	case u.TOTPEnabled:
		return next2FAVerify, sid, nil
	default:
		return next2FAEnroll, sid, nil
	}
}

// loginAlert tells the team about a login from an IP/browser this user hasn't
// used before (if that alert is switched on).
func (s *Server) loginAlert(r *http.Request, u *store.User, sessionID string) {
	ip := clientIP(r)
	known, err := s.store.KnownDevice(r.Context(), u.ID, ip, r.UserAgent(), sessionID)
	if err != nil || known {
		return
	}
	s.alerts.NewDeviceLogin(u, ip, r.UserAgent())
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		Secure: s.settings.Get().SecureCookies(), SameSite: http.SameSiteLaxMode})
}

// completeLogin finalizes a session after 2FA succeeds.
func (s *Server) completeLogin(ctx context.Context, a *authCtx) error {
	if err := s.store.MarkSessionMFA(ctx, a.sess.ID); err != nil {
		return err
	}
	if err := s.store.TouchSession(ctx, a.sess.ID, time.Now().Add(s.settings.Get().SessionTTL())); err != nil {
		return err
	}
	a.sess.MFAVerified = true
	return s.store.TouchLogin(ctx, a.user.ID)
}

// ---- handlers ----

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	exists, err := s.store.OwnerExists(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"company_name":   s.settings.Get().CompanyName,
		"version":        s.version,
		"env":            s.cfg.Env,
		"setup_required": !exists,
		"two_fa_mode":    s.cfg.TwoFAMode,
		"backup_enabled": s.settings.Get().BackupEnabled,
		"look":           s.look(),
		"modules": map[string]bool{
			"scheduler": s.settings.Get().ModuleScheduler,
			"vault":     s.settings.Get().ModuleVault,
		},
	})
}

func validateEmail(email string) (string, error) {
	email = strings.TrimSpace(email)
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || len(email) > 254 {
		return "", errors.New("enter a valid email address")
	}
	return email, nil
}

func validateName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 100 {
		return "", errors.New("name must be 1–100 characters")
	}
	return name, nil
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code     string `json:"code"`
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	if s.setupLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	exists, err := s.store.OwnerExists(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if exists {
		s.clearSetupCode()
		writeError(w, http.StatusNotFound, "setup already completed")
		return
	}
	if !s.checkSetupCode(in.Code) {
		s.setupLimiter.Fail(ip)
		writeError(w, http.StatusForbidden, "invalid setup code — check the Rexus server logs")
		return
	}
	email, err := validateEmail(in.Email)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name, err := validateName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := auth.ValidatePassword(in.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	u, err := s.store.CreateOwner(r.Context(), email, name, hash)
	if errors.Is(err, store.ErrOwnerExists) {
		s.clearSetupCode()
		writeError(w, http.StatusConflict, "an owner already exists")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.clearSetupCode()
	s.store.Audit(r.Context(), store.AuditEntry{ActorUserID: &u.ID, Actor: u.Email, Action: "setup.owner_created",
		TargetType: "user", TargetID: u.ID, IP: ip, Details: map[string]any{"via": "ui"}})
	s.log.Info("owner created via setup screen", "email", u.Email)

	next, _, err := s.startSession(w, r, u)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if next == nextOK {
		s.store.TouchLogin(r.Context(), u.ID)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": u, "next": next})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	emailKey := "email:" + strings.ToLower(strings.TrimSpace(in.Email))
	if s.loginLimiter.Blocked("ip:"+ip) || s.loginLimiter.Blocked(emailKey) {
		writeError(w, http.StatusTooManyRequests, "too many failed attempts — try again in 15 minutes")
		return
	}

	u, err := s.store.UserByEmail(r.Context(), in.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.internalError(w, r, err)
		return
	}
	hash := ""
	if u != nil {
		hash = u.PasswordHash
	}
	if !auth.VerifyPassword(in.Password, hash) || u == nil || u.Status != "active" {
		s.loginLimiter.Fail("ip:" + ip)
		s.loginLimiter.Fail(emailKey)
		s.store.Audit(r.Context(), store.AuditEntry{Actor: strings.TrimSpace(in.Email), Action: "auth.login_failed", IP: ip})
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if s.cfg.LoginOwnerOnly && u.Role != "owner" {
		writeError(w, http.StatusForbidden, "Rexus is in lockdown mode: only the owner can log in")
		return
	}
	s.loginLimiter.Reset("ip:" + ip)
	s.loginLimiter.Reset(emailKey)

	next, sid, err := s.startSession(w, r, u)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if next == nextOK {
		s.store.TouchLogin(r.Context(), u.ID)
		s.store.Audit(r.Context(), store.AuditEntry{ActorUserID: &u.ID, Actor: u.Email, Action: "auth.login", IP: ip})
		s.loginAlert(r, u, sid)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "next": next})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, a *authCtx) {
	writeJSON(w, http.StatusOK, map[string]any{"user": a.user, "next": nextStep(a)})
}

// handleUpdateProfile lets anyone change their own display name. The email is the sign-in identity, so it stays.
func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var in struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := validateName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.SetName(r.Context(), a.user.ID, name); err != nil {
		s.internalError(w, r, err)
		return
	}
	u, err := s.store.UserByID(r.Context(), a.user.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.rename", "user", a.user.ID, map[string]any{"name": name})
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if err := s.store.RevokeSession(r.Context(), a.sess.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.clearCookie(w)
	s.audit(r, a, "auth.logout", "", "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// verifyCode checks a TOTP code against the user's enabled secret.
func (s *Server) verifyCode(ctx context.Context, u *store.User, code string) (bool, error) {
	secret, err := s.keys.Decrypt(u.TOTPSecret, totpAAD(u.ID))
	if err != nil {
		return false, err
	}
	step, ok := auth.VerifyTOTP(string(secret), code, u.TOTPLastStep, time.Now())
	if !ok {
		return false, nil
	}
	return s.store.UseTOTPStep(ctx, u.ID, step) // false = code replayed
}

func (s *Server) handle2FAVerify(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var in struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if a.sess.MFAVerified {
		writeJSON(w, http.StatusOK, map[string]any{"user": a.user, "next": nextOK})
		return
	}
	if !a.user.TOTPEnabled {
		writeError(w, http.StatusBadRequest, "2FA is not set up for this account")
		return
	}
	key := "user:" + a.user.ID
	if s.mfaLimiter.Blocked(key) {
		writeError(w, http.StatusTooManyRequests, "too many wrong codes — try again in 15 minutes")
		return
	}
	ok, err := s.verifyCode(r.Context(), a.user, in.Code)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		s.mfaLimiter.Fail(key)
		s.audit(r, a, "auth.2fa_failed", "", "", nil)
		writeError(w, http.StatusUnauthorized, "invalid code")
		return
	}
	s.mfaLimiter.Reset(key)
	if err := s.completeLogin(r.Context(), a); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "auth.login", "", "", map[string]any{"2fa": true})
	s.loginAlert(r, a.user, a.sess.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": a.user, "next": nextOK})
}

func (s *Server) handle2FASetup(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !s.cfg.TwoFAAllowed() {
		writeError(w, http.StatusBadRequest, "2FA is disabled on this instance (REXUS_2FA_MODE=off)")
		return
	}
	if a.user.TOTPEnabled {
		writeError(w, http.StatusConflict, "2FA is already enabled")
		return
	}
	secret := auth.NewTOTPSecret()
	enc, err := s.keys.Encrypt([]byte(secret), totpAAD(a.user.ID))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.store.SetTOTPPending(r.Context(), a.user.ID, enc); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":      secret,
		"otpauth_url": auth.TOTPURL("Rexus ("+s.settings.Get().CompanyName+")", a.user.Email, secret),
	})
}

func (s *Server) handle2FAEnable(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var in struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if a.user.TOTPEnabled {
		writeError(w, http.StatusConflict, "2FA is already enabled")
		return
	}
	if len(a.user.TOTPPendingSecret) == 0 {
		writeError(w, http.StatusBadRequest, "start 2FA setup first")
		return
	}
	key := "user:" + a.user.ID
	if s.mfaLimiter.Blocked(key) {
		writeError(w, http.StatusTooManyRequests, "too many wrong codes — try again in 15 minutes")
		return
	}
	secret, err := s.keys.Decrypt(a.user.TOTPPendingSecret, totpAAD(a.user.ID))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	step, ok := auth.VerifyTOTP(string(secret), in.Code, 0, time.Now())
	if !ok {
		s.mfaLimiter.Fail(key)
		writeError(w, http.StatusUnauthorized, "invalid code — check your authenticator app's time")
		return
	}
	s.mfaLimiter.Reset(key)
	if err := s.store.EnableTOTP(r.Context(), a.user.ID, a.user.TOTPPendingSecret, step); err != nil {
		s.internalError(w, r, err)
		return
	}
	a.user.TOTPEnabled = true
	wasPartial := !a.sess.MFAVerified
	if err := s.completeLogin(r.Context(), a); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "auth.2fa_enabled", "user", a.user.ID, nil)
	if wasPartial {
		s.audit(r, a, "auth.login", "", "", map[string]any{"2fa": true})
		s.loginAlert(r, a.user, a.sess.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": a.user, "next": nextOK})
}

func (s *Server) handle2FADisable(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var in struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !a.user.TOTPEnabled {
		writeError(w, http.StatusBadRequest, "2FA is not enabled")
		return
	}
	if s.cfg.TwoFARequiredFor(a.user.Role) {
		writeError(w, http.StatusForbidden, "2FA is required for your role on this instance")
		return
	}
	ok, err := s.verifyCode(r.Context(), a.user, in.Code)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid code")
		return
	}
	if err := s.store.ResetTOTP(r.Context(), a.user.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	a.user.TOTPEnabled = false
	s.audit(r, a, "auth.2fa_disabled", "user", a.user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]any{"user": a.user})
}
