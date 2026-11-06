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
		"defaults":     map[string]any{"company_name": d.CompanyName, "base_url": d.BaseURL, "modules": modules(d)},
		"modules":      modules(v),
		// Backups can only be switched on when REXUS_BACKUP_DIR is set (it is a folder mounted into the container).
		"backup_dir_set": v.BackupDirSet,
	}
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
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	patch := appsettings.Patch{CompanyName: in.CompanyName, BaseURL: in.BaseURL, ResetModules: in.ResetModules}
	if m := in.Modules; m != nil {
		patch.ModuleVault, patch.ModuleScheduler, patch.BackupEnabled = m.Vault, m.Scheduler, m.Backups
	}
	if patch.CompanyName == nil && patch.BaseURL == nil && patch.ModuleVault == nil && patch.ModuleScheduler == nil &&
		patch.BackupEnabled == nil && !patch.ResetModules {
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
