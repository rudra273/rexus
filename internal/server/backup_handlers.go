package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"rexus/internal/backup"
	"rexus/internal/db"
	"rexus/internal/store"
)

// backupsOn answers 404 (with the reason) when backups aren't switched on.
func (s *Server) backupsOn(w http.ResponseWriter) bool {
	if !s.settings.Get().BackupEnabled {
		writeError(w, http.StatusNotFound, "backups are switched off — turn them on in Settings → Modules (the backup folder, REXUS_BACKUP_DIR, must be set in .env first)")
		return false
	}
	return true
}

type backupRow struct {
	*store.BackupRecord
	OnDisk bool `json:"on_disk"` // the file is still in the backup folder
}

func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.backupsOn(w) {
		return
	}
	st, err := s.backups.Status(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	recs, err := s.store.ListBackupRecords(r.Context(), 60)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	onDisk := map[string]bool{}
	if files, err := s.backups.Files(); err == nil {
		for _, f := range files {
			onDisk[f.Name] = true
		}
	}
	rows := make([]backupRow, 0, len(recs))
	for _, rec := range recs {
		rows = append(rows, backupRow{BackupRecord: rec, OnDisk: rec.FileName != nil && onDisk[*rec.FileName]})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      st,
		"backups":     rows,
		"intervals":   backup.AllowedIntervals,
		"dir_problem": s.backups.CheckDir(),
	})
}

// handleBackupStatus is the light call behind the always-visible "last backup" indicator.
func (s *Server) handleBackupStatus(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	if !s.settings.Get().BackupEnabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	st, err := s.backups.Status(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleRunBackup(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.backupsOn(w) {
		return
	}
	if err := s.backups.Trigger("manual", &a.user.ID); err != nil {
		if errors.Is(err, backup.ErrBusy) {
			writeError(w, http.StatusConflict, "a backup is already running")
			return
		}
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "backup.run", "backup", "", nil)
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

func (s *Server) handleBackupSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.backupsOn(w) {
		return
	}
	var in backup.Settings
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.backups.SetSettings(r.Context(), in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.audit(r, a, "backup.settings", "backup", "", map[string]any{"interval_minutes": in.IntervalMinutes, "keep": in.Keep})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- restore from the setup screen ----
//
// Only possible while Rexus has no owner (a brand-new or wiped database), and
// protected by the same one-time setup code as creating the owner. A running
// instance's data can never be overwritten from here.

func (s *Server) handleSetupBackups(w http.ResponseWriter, r *http.Request) {
	if exists, err := s.store.OwnerExists(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	} else if exists {
		writeError(w, http.StatusNotFound, "setup already completed")
		return
	}
	if !s.settings.Get().BackupEnabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "files": []any{}})
		return
	}
	files, err := s.backups.Files()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "files": []any{}, "problem": "can't read the backup folder"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "files": files})
}

func (s *Server) handleSetupRestore(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
		File string `json:"file"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	if s.setupLimiter.Blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again in 15 minutes")
		return
	}
	if exists, err := s.store.OwnerExists(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	} else if exists {
		s.clearSetupCode()
		writeError(w, http.StatusNotFound, "setup already completed")
		return
	}
	if !s.checkSetupCode(in.Code) {
		s.setupLimiter.Fail(ip)
		writeError(w, http.StatusForbidden, "invalid setup code — check the Rexus server logs")
		return
	}
	if !s.settings.Get().BackupEnabled {
		writeError(w, http.StatusBadRequest, "backups are switched off — turn them on in Settings → Modules (the backup folder, REXUS_BACKUP_DIR, must be set in .env first)")
		return
	}
	path, err := s.backups.ResolveFile(in.File)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// A big restore can outlast the request; it must not be cancelled half way.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 35*time.Minute)
	defer cancel()
	s.log.Warn("restoring database from backup", "file", in.File)
	if err := s.backups.Restore(ctx, path); err != nil {
		switch {
		case errors.Is(err, backup.ErrBusy), errors.Is(err, backup.ErrNotEmpty):
			writeError(w, http.StatusConflict, err.Error())
		default:
			s.log.Error("restore failed", "file", in.File, "err", err)
			writeError(w, http.StatusInternalServerError, "restore failed: "+err.Error())
		}
		return
	}
	// The tables were replaced underneath open connections: drop them, and
	// bring the restored schema up to date if the backup came from an older Rexus.
	s.store.Pool.Reset()
	if err := db.Migrate(ctx, s.store.Pool, s.log); err != nil {
		s.log.Error("migrate after restore", "err", err)
		writeError(w, http.StatusInternalServerError, "the backup was restored, but updating the database failed: "+err.Error())
		return
	}

	// A backup taken from an empty database restores fine but has no accounts in it:
	// say so, and stay in setup mode.
	exists, _ := s.store.OwnerExists(ctx)
	resp := map[string]any{"ok": true, "owner_exists": exists}
	if exists {
		s.clearSetupCode()
	}
	if checked, kerr := backup.CheckMasterKey(ctx, s.store, s.keys); checked && kerr != nil {
		resp["warning"] = backup.KeyWarning
	}
	s.store.Audit(ctx, store.AuditEntry{Actor: "setup", Action: "backup.restore", TargetType: "backup", TargetID: in.File, IP: ip,
		Details: map[string]any{"file": in.File, "via": "setup screen"}})
	s.log.Info("restore finished", "file", in.File)
	writeJSON(w, http.StatusOK, resp)
}
