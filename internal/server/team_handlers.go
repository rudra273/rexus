package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rexus/internal/auth"
	"rexus/internal/crypto"
	"rexus/internal/store"
)

const (
	inviteTTL = 7 * 24 * time.Hour
	resetTTL  = 24 * time.Hour
)

// ---- permissions (plan.md §5) ----

func isAdminRole(role string) bool { return role == "owner" || role == "admin" }

func requireAdmin(w http.ResponseWriter, a *authCtx) bool {
	if !isAdminRole(a.user.Role) {
		writeError(w, http.StatusForbidden, "only the owner or an admin can do this")
		return false
	}
	return true
}

// assignableRoles are the roles the actor may give to others. The owner role
// is never assignable — it only moves through an ownership transfer.
func assignableRoles(actorRole string) []string {
	switch actorRole {
	case "owner":
		return []string{"admin", "contributor", "viewer"}
	case "admin":
		return []string{"contributor", "viewer"}
	}
	return nil
}

func roleAssignable(actorRole, role string) bool {
	for _, r := range assignableRoles(actorRole) {
		if r == role {
			return true
		}
	}
	return false
}

// canManage reports whether actor may change/disable/remove/reset target.
// Nobody manages themselves here, nobody touches the owner, and an admin can
// only manage contributors and viewers.
func canManage(actor, target *store.User) bool {
	if actor.ID == target.ID || target.Role == "owner" {
		return false
	}
	switch actor.Role {
	case "owner":
		return true
	case "admin":
		return target.Role == "contributor" || target.Role == "viewer"
	}
	return false
}

func (s *Server) loadManagedUser(w http.ResponseWriter, r *http.Request, a *authCtx) (*store.User, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "user not found")
		return nil, false
	}
	u, err := s.store.UserByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "user not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	if !canManage(a.user, u) {
		writeError(w, http.StatusForbidden, "you can't manage this user")
		return nil, false
	}
	return u, true
}

// ---- users ----

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	grants, err := s.store.GrantsByUser(r.Context(), s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":            users,
		"grants":           grants, // user ID → keys of the projects shared with them (only ones you can see)
		"assignable_roles": assignableRoles(a.user.Role),
	})
}

// projectIDsFor turns project keys into IDs, refusing any the actor can't see —
// nobody can hand out access to a project they don't have themselves.
func (s *Server) projectIDsFor(w http.ResponseWriter, r *http.Request, keys []string) ([]string, bool) {
	ids, ok, err := s.store.ProjectIDsByKeys(r.Context(), keys)
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	if !ok {
		writeError(w, http.StatusBadRequest, "one of the projects doesn't exist")
		return nil, false
	}
	for _, id := range ids {
		can, err := s.store.CanSee(r.Context(), s.access(r), id)
		if err != nil {
			s.internalError(w, r, err)
			return nil, false
		}
		if !can {
			writeError(w, http.StatusBadRequest, "one of the projects doesn't exist")
			return nil, false
		}
	}
	return ids, true
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	u, ok := s.loadManagedUser(w, r, a)
	if !ok {
		return
	}
	var in struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
		// Project access: AllProjects is for admins (owner sets it); Projects are the keys shared
		// with the user — within what you can see; grants to projects you can't see stay as they are.
		AllProjects *bool     `json:"all_projects"`
		Projects    *[]string `json:"projects"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Role == nil && in.Status == nil && in.AllProjects == nil && in.Projects == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	// Validate the access change up front, so nothing is half-applied.
	targetRole := u.Role
	if in.Role != nil {
		targetRole = *in.Role
	}
	if in.AllProjects != nil {
		if a.user.Role != "owner" {
			writeError(w, http.StatusForbidden, "only the owner can give an admin access to all projects")
			return
		}
		if *in.AllProjects && targetRole != "admin" {
			writeError(w, http.StatusBadRequest, "only admins can have access to all projects")
			return
		}
	}
	var grantIDs []string
	if in.Projects != nil {
		if targetRole == "admin" && a.user.Role != "owner" {
			writeError(w, http.StatusForbidden, "only the owner can choose which projects an admin sees")
			return
		}
		var ok bool
		if grantIDs, ok = s.projectIDsFor(w, r, *in.Projects); !ok {
			return
		}
	}
	if in.Role != nil && *in.Role != u.Role {
		if !roleAssignable(a.user.Role, *in.Role) {
			writeError(w, http.StatusForbidden, "you can't give someone the "+*in.Role+" role")
			return
		}
		if err := s.store.SetUserRole(r.Context(), u.ID, *in.Role); err != nil {
			s.internalError(w, r, err)
			return
		}
		s.audit(r, a, "user.role_change", "user", u.ID, map[string]any{"email": u.Email, "from": u.Role, "to": *in.Role})
	}
	if in.Status != nil && *in.Status != u.Status {
		if *in.Status != "active" && *in.Status != "disabled" {
			writeError(w, http.StatusBadRequest, "status must be active or disabled")
			return
		}
		if err := s.store.SetUserStatus(r.Context(), u.ID, *in.Status); err != nil {
			s.internalError(w, r, err)
			return
		}
		action := "user.enable"
		if *in.Status == "disabled" {
			action = "user.disable"
			// Disabling logs the user out immediately.
			if err := s.store.RevokeUserSessions(r.Context(), u.ID); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
		s.audit(r, a, action, "user", u.ID, map[string]any{"email": u.Email})
	}
	if in.AllProjects != nil {
		if err := s.store.SetAllProjects(r.Context(), u.ID, *in.AllProjects); err != nil {
			s.internalError(w, r, err)
			return
		}
		s.audit(r, a, "user.access", "user", u.ID, map[string]any{"email": u.Email, "all_projects": *in.AllProjects})
	}
	if in.Projects != nil {
		scope, err := s.store.VisibleProjectIDs(r.Context(), s.access(r))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		before, err := s.store.UserGrantIDs(r.Context(), u.ID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if err := s.store.SetUserGrants(r.Context(), u.ID, grantIDs, scope, a.user.ID); err != nil {
			s.internalError(w, r, err)
			return
		}
		// One entry per project, each tied to that project: people only read the
		// history of projects they can see (so a hidden project's name never leaks).
		inSet := func(list []string) map[string]bool {
			m := map[string]bool{}
			for _, x := range list {
				m[x] = true
			}
			return m
		}
		was, now, inScope := inSet(before), inSet(grantIDs), inSet(scope)
		keys, _ := s.store.ProjectKeysByIDs(r.Context(), append(append([]string{}, before...), grantIDs...))
		for id := range now {
			if !was[id] {
				s.auditProject(r, a, id, "user.access_grant", "user", u.ID, map[string]any{"email": u.Email, "project": keys[id]})
			}
		}
		for id := range was {
			if inScope[id] && !now[id] {
				s.auditProject(r, a, id, "user.access_revoke", "user", u.ID, map[string]any{"email": u.Email, "project": keys[id]})
			}
		}
	}
	updated, err := s.store.UserByID(r.Context(), u.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	u, ok := s.loadManagedUser(w, r, a)
	if !ok {
		return
	}
	if err := s.store.DeleteUser(r.Context(), u.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.delete", "user", u.ID, map[string]any{"email": u.Email, "role": u.Role})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleResetPasswordLink gives the admin a one-time link to hand to the
// user. The admin never sees or sets the password.
func (s *Server) handleResetPasswordLink(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	u, ok := s.loadManagedUser(w, r, a)
	if !ok {
		return
	}
	if u.Status != "active" {
		writeError(w, http.StatusBadRequest, "this user is disabled — enable them first")
		return
	}
	token := crypto.RandomToken(32)
	expires := time.Now().Add(resetTTL)
	if err := s.store.CreatePasswordReset(r.Context(), u.ID, crypto.HashToken(token), a.user.ID, expires); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.reset_link", "user", u.ID, map[string]any{"email": u.Email})
	link := s.settings.Get().BaseURL + "/reset/" + token
	resp := map[string]any{"link": link, "expires_at": expires, "emailed": false}
	if s.alerts.SMTPConfigured() {
		if err := s.alerts.SendPasswordReset(r.Context(), u.Email, link, a.user.Name); err != nil {
			s.log.Warn("reset email failed", "to", u.Email, "err", err)
			resp["email_error"] = err.Error()
		} else {
			resp["emailed"] = true
		}
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleReset2FA(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	u, ok := s.loadManagedUser(w, r, a)
	if !ok {
		return
	}
	if err := s.store.ResetTOTP(r.Context(), u.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.store.RevokeUserSessions(r.Context(), u.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.reset_2fa", "user", u.ID, map[string]any{"email": u.Email})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- invites (admin side) ----

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	invites, err := s.store.ListInvites(r.Context(), s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
		// What the new user will see once they join (see handleUpdateUser).
		AllProjects bool     `json:"all_projects"`
		Projects    []string `json:"projects"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	email, err := validateEmail(in.Email)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !roleAssignable(a.user.Role, in.Role) {
		writeError(w, http.StatusForbidden, "you can't invite someone as "+strconv.Quote(in.Role))
		return
	}
	if in.AllProjects && (in.Role != "admin" || a.user.Role != "owner") {
		writeError(w, http.StatusBadRequest, "only the owner can invite an admin with access to all projects")
		return
	}
	if len(in.Projects) > 0 && in.Role == "admin" && a.user.Role != "owner" {
		writeError(w, http.StatusForbidden, "only the owner can choose which projects an admin sees")
		return
	}
	projectIDs := []string{}
	if len(in.Projects) > 0 {
		var ok bool
		if projectIDs, ok = s.projectIDsFor(w, r, in.Projects); !ok {
			return
		}
	}
	token := crypto.RandomToken(32)
	inv, err := s.store.CreateInvite(r.Context(), email, in.Role, crypto.HashToken(token), a.user.ID, time.Now().Add(inviteTTL), in.AllProjects, projectIDs)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "a user with this email already exists")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.invite", "invite", inv.ID, map[string]any{"email": inv.Email, "role": inv.Role, "all_projects": in.AllProjects, "project_count": len(projectIDs)})
	keys, _ := s.store.ProjectKeysByIDs(r.Context(), projectIDs)
	for _, id := range projectIDs {
		s.auditProject(r, a, id, "user.invite_access", "invite", inv.ID, map[string]any{"email": inv.Email, "project": keys[id]})
	}
	// The link is shown once — only its hash is stored. Re-invite for a new one.
	link := s.settings.Get().BaseURL + "/invite/" + token
	resp := map[string]any{"invite": inv, "link": link, "emailed": false}
	if s.alerts.SMTPConfigured() {
		if err := s.alerts.SendInvite(r.Context(), inv.Email, link, inv.Role, a.user.Name); err != nil {
			s.log.Warn("invite email failed", "to", inv.Email, "err", err)
			resp["email_error"] = err.Error()
		} else {
			resp["emailed"] = true
		}
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "invite not found")
		return
	}
	inv, err := s.store.RevokeInvite(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "invite not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "user.invite_revoke", "invite", inv.ID, map[string]any{"email": inv.Email})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- public: accept an invite / use a reset link ----

const linkInvalid = "this link is invalid or has expired"

func (s *Server) handleJoinInfo(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.linkLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	inv, err := s.store.InviteByTokenHash(r.Context(), crypto.HashToken(r.PathValue("token")))
	if errors.Is(err, store.ErrNotFound) {
		s.linkLimiter.Fail(ip)
		writeError(w, http.StatusNotFound, linkInvalid)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": inv.Email, "role": inv.Role, "company_name": s.settings.Get().CompanyName})
}

func (s *Server) handleJoinAccept(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.linkLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	var in struct {
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &in) {
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
	u, err := s.store.AcceptInvite(r.Context(), crypto.HashToken(r.PathValue("token")), name, hash)
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.linkLimiter.Fail(ip)
		writeError(w, http.StatusNotFound, linkInvalid)
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "an account with this email already exists")
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	s.store.Audit(r.Context(), store.AuditEntry{ActorUserID: &u.ID, Actor: u.Email, Action: "user.invite_accept",
		TargetType: "user", TargetID: u.ID, IP: ip, Details: map[string]any{"role": u.Role}})

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

func (s *Server) handleResetInfo(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.linkLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	email, err := s.store.ResetEmail(r.Context(), crypto.HashToken(r.PathValue("token")))
	if errors.Is(err, store.ErrNotFound) {
		s.linkLimiter.Fail(ip)
		writeError(w, http.StatusNotFound, linkInvalid)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": email})
}

func (s *Server) handleResetUse(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.linkLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &in) {
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
	u, err := s.store.UsePasswordReset(r.Context(), crypto.HashToken(r.PathValue("token")), hash)
	if errors.Is(err, store.ErrNotFound) {
		s.linkLimiter.Fail(ip)
		writeError(w, http.StatusNotFound, linkInvalid)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.store.Audit(r.Context(), store.AuditEntry{ActorUserID: &u.ID, Actor: u.Email, Action: "auth.password_reset",
		TargetType: "user", TargetID: u.ID, IP: ip})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- own account ----

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, a *authCtx) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	key := "pw:" + a.user.ID
	if s.loginLimiter.Blocked(key) {
		writeError(w, http.StatusTooManyRequests, "too many failed attempts — try again in 15 minutes")
		return
	}
	if !auth.VerifyPassword(in.CurrentPassword, a.user.PasswordHash) {
		s.loginLimiter.Fail(key)
		writeError(w, http.StatusUnauthorized, "current password is wrong")
		return
	}
	if err := auth.ValidatePassword(in.NewPassword); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.store.SetPassword(r.Context(), a.user.ID, hash); err != nil {
		s.internalError(w, r, err)
		return
	}
	// Other devices are logged out; this one stays.
	if err := s.store.RevokeOtherSessions(r.Context(), a.user.ID, a.sess.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.loginLimiter.Reset(key)
	s.audit(r, a, "auth.password_change", "user", a.user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if err := s.store.RevokeUserSessions(r.Context(), a.user.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.clearCookie(w)
	s.audit(r, a, "auth.logout_all", "user", a.user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleTransferOwnership hands the owner role to another active user. It
// needs the owner's password (and 2FA code, if enabled) as confirmation.
func (s *Server) handleTransferOwnership(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if a.user.Role != "owner" {
		writeError(w, http.StatusForbidden, "only the owner can transfer ownership")
		return
	}
	var in struct {
		UserID   string `json:"user_id"`
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	key := "pw:" + a.user.ID
	if s.loginLimiter.Blocked(key) {
		writeError(w, http.StatusTooManyRequests, "too many failed attempts — try again in 15 minutes")
		return
	}
	if !auth.VerifyPassword(in.Password, a.user.PasswordHash) {
		s.loginLimiter.Fail(key)
		writeError(w, http.StatusUnauthorized, "password is wrong")
		return
	}
	if !store.IsUUID(in.UserID) || in.UserID == a.user.ID {
		writeError(w, http.StatusBadRequest, "choose another active user")
		return
	}
	target, err := s.store.UserByID(r.Context(), in.UserID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && target.Status != "active") {
		writeError(w, http.StatusBadRequest, "choose another active user")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// 2FA is checked last: a TOTP code works only once, so it must not be
	// used up by a request that was going to fail anyway.
	if a.user.TOTPEnabled {
		ok, err := s.verifyCode(r.Context(), a.user, in.Code)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !ok {
			s.loginLimiter.Fail(key)
			writeError(w, http.StatusUnauthorized, "invalid 2FA code")
			return
		}
	}

	if err := s.store.TransferOwnership(r.Context(), a.user.ID, target.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.loginLimiter.Reset(key)
	s.audit(r, a, "owner.transfer", "user", target.ID, map[string]any{"from": a.user.Email, "to": target.Email})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- audit log ----

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	q := r.URL.Query()
	limit := 100
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}
	var before int64
	if v := q.Get("before"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid 'before'")
			return
		}
		before = n
	}
	var since time.Time
	if v := q.Get("days"); v != "" {
		days, err := strconv.Atoi(v)
		if err != nil || days < 1 || days > 365 {
			writeError(w, http.StatusBadRequest, "days must be between 1 and 365")
			return
		}
		since = time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	}
	rows, err := s.store.ListAudit(r.Context(), strings.TrimSpace(q.Get("q")), q.Get("category"), since, before, limit+1, s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": rows, "has_more": hasMore})
}
