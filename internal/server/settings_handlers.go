package server

import (
	"errors"
	"net/http"

	"rexus/internal/appsettings"
)

// settingsPayload is what the Settings page shows: the values that apply now, where each one comes from
// (the .env file or saved from the page), the .env defaults, and whether this person may change them (the
// owner and admins may).
func (s *Server) settingsPayload(a *authCtx) map[string]any {
	v := s.settings.Get()
	d := s.settings.Defaults()
	return map[string]any{
		"company_name": v.CompanyName,
		"base_url":     v.BaseURL,
		"version":      s.version,
		"toggles":      s.cfg.Toggles(),
		"smtp":         map[string]any{"configured": s.alerts.SMTPConfigured(), "host": s.alerts.SMTPHost()},
		"editable":     isAdminRole(a.user.Role),
		"sources":      s.settings.Sources(),
		"defaults":     map[string]any{"company_name": d.CompanyName, "base_url": d.BaseURL},
	}
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !isAdminRole(a.user.Role) {
		writeError(w, http.StatusForbidden, "only the owner or an admin can view instance settings")
		return
	}
	writeJSON(w, http.StatusOK, s.settingsPayload(a))
}

// handleUpdateSettings changes the company name and/or the public URL. Owner or admin: these show up in
// emailed links and decide whether login cookies are marked Secure, and every change is in the audit log. A
// field that is left out stays as it is; an empty string clears the saved value, so the default from .env
// applies again.
func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in struct {
		CompanyName *string `json:"company_name"`
		BaseURL     *string `json:"base_url"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.CompanyName == nil && in.BaseURL == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	old := s.settings.Get()
	now, err := s.settings.Update(r.Context(), appsettings.Patch{CompanyName: in.CompanyName, BaseURL: in.BaseURL})
	if err != nil {
		var bad *appsettings.InvalidError
		if errors.As(err, &bad) {
			writeError(w, http.StatusBadRequest, bad.Msg)
			return
		}
		s.internalError(w, r, err)
		return
	}
	details := map[string]any{}
	if in.CompanyName != nil {
		details["company_name"] = map[string]any{"from": old.CompanyName, "to": now.CompanyName}
	}
	if in.BaseURL != nil {
		details["base_url"] = map[string]any{"from": old.BaseURL, "to": now.BaseURL}
	}
	s.audit(r, a, "settings.update", "settings", "", details)
	writeJSON(w, http.StatusOK, s.settingsPayload(a))
}
