package server

import (
	"errors"
	"net/http"
	"strconv"

	"rexus/internal/appsettings"
)

// settingsPayload is what the Settings page shows: the values that apply now, where each one comes from
// (the .env file or saved from the page), the .env defaults, and whether this person may change them (the
// owner and admins may).
func (s *Server) settingsPayload(a *authCtx) map[string]any {
	v := s.settings.Get()
	d := s.settings.Defaults()
	return map[string]any{
		"company_name":  v.CompanyName,
		"base_url":      v.BaseURL,
		"version":       s.version,
		"toggles":       s.cfg.Toggles(),
		"smtp":          map[string]any{"configured": s.alerts.SMTPConfigured(), "host": s.alerts.SMTPHost()},
		"editable":      isAdminRole(a.user.Role),
		"sources":       s.settings.Sources(),
		"defaults":      map[string]any{"company_name": d.CompanyName, "base_url": d.BaseURL, "modules": modules(d)},
		"modules":       modules(v),
		"look":          s.look(),
		"session_hours": v.SessionHours,
		"defaults_look": map[string]any{"session_hours": appsettings.DefaultSessionHours},
		"max_logo_kb":   appsettings.MaxLogoBytes >> 10,
	}
}

// look is how this instance looks to everyone, before a person's own choices in Profile: it goes out with the
// public /api/meta so the login page can show the logo and colour too.
func (s *Server) look() map[string]any {
	v := s.settings.Get()
	logo := ""
	if v.Logo != "" {
		logo = "/api/brand/logo?v=" + v.LogoVersion
	}
	return map[string]any{"timezone": v.Timezone, "date_format": v.DateFormat, "accent_color": v.AccentColor, "logo_url": logo}
}

// handleBrandLogo serves the uploaded logo. It is public (the login page shows it) and the URL carries a version,
// so browsers can keep it for good. An SVG is only ever shown through an <img>, and the sandbox policy stops any
// script in it from running if someone opens the file directly.
func (s *Server) handleBrandLogo(w http.ResponseWriter, r *http.Request) {
	v := s.settings.Get()
	if v.Logo == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ct, body, err := appsettings.ParseLogo(v.Logo)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	_, _ = w.Write(body)
}

// modules is the three switches as the page shows them.
func modules(v appsettings.Values) map[string]bool {
	return map[string]bool{"vault": v.ModuleVault, "scheduler": v.ModuleScheduler, "backups": v.BackupEnabled}
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !isAdminRole(a.user.Role) {
		writeError(w, http.StatusForbidden, "only the owner or an admin can view instance settings")
		return
	}
	writeJSON(w, http.StatusOK, s.settingsPayload(a))
}

// handleUpdateSettings changes the company name, the public URL and/or the module switches. Owner or admin:
// these show up in emailed links, decide whether login cookies are marked Secure, and switch parts of Rexus on
// and off, and every change is in the audit log. A field that is left out stays as it is. For the two text
// settings an empty string clears the saved value; for the modules, reset_modules puts all three switches
// back to the values from .env.
func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in struct {
		CompanyName *string `json:"company_name"`
		BaseURL     *string `json:"base_url"`
		// Modules switches Vault, Scheduler and Backups on or off; a switch that is left out stays as it is.
		Modules *struct {
			Vault     *bool `json:"vault"`
			Scheduler *bool `json:"scheduler"`
			Backups   *bool `json:"backups"`
		} `json:"modules"`
		ResetModules bool `json:"reset_modules"`

		// Look and feel and sessions. "" (0 for session_hours) goes back to the default.
		Timezone     *string `json:"timezone"`
		DateFormat   *string `json:"date_format"`
		AccentColor  *string `json:"accent_color"`
		Logo         *string `json:"logo"`
		SessionHours *int    `json:"session_hours"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	patch := appsettings.Patch{CompanyName: in.CompanyName, BaseURL: in.BaseURL, ResetModules: in.ResetModules,
		Timezone: in.Timezone, DateFormat: in.DateFormat, AccentColor: in.AccentColor, Logo: in.Logo, SessionHours: in.SessionHours}
	if m := in.Modules; m != nil {
		patch.ModuleVault, patch.ModuleScheduler, patch.BackupEnabled = m.Vault, m.Scheduler, m.Backups
	}
	if patch.CompanyName == nil && patch.BaseURL == nil && patch.ModuleVault == nil && patch.ModuleScheduler == nil &&
		patch.BackupEnabled == nil && !patch.ResetModules && patch.Timezone == nil && patch.DateFormat == nil &&
		patch.AccentColor == nil && patch.Logo == nil && patch.SessionHours == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	old := s.settings.Get()
	now, err := s.settings.Update(r.Context(), patch)
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
	for name, pair := range map[string][2]string{
		"timezone":      {old.Timezone, now.Timezone},
		"date_format":   {old.DateFormat, now.DateFormat},
		"accent_color":  {old.AccentColor, now.AccentColor},
		"logo":          {old.LogoVersion, now.LogoVersion}, // the image itself isn't written to the audit log
		"session_hours": {strconv.Itoa(old.SessionHours), strconv.Itoa(now.SessionHours)},
	} {
		if pair[0] != pair[1] {
			details[name] = map[string]any{"from": pair[0], "to": pair[1]}
		}
	}
	mods := map[string]any{}
	for name, pair := range map[string][2]bool{
		"vault":     {old.ModuleVault, now.ModuleVault},
		"scheduler": {old.ModuleScheduler, now.ModuleScheduler},
		"backups":   {old.BackupEnabled, now.BackupEnabled},
	} {
		if pair[0] != pair[1] {
			mods[name] = map[string]any{"from": pair[0], "to": pair[1]}
		}
	}
	if len(mods) > 0 {
		details["modules"] = mods
	}
	if in.ResetModules {
		details["modules_reset"] = true
	}
	s.audit(r, a, "settings.update", "settings", "", details)
	writeJSON(w, http.StatusOK, s.settingsPayload(a))
}
