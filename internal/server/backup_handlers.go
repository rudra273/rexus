package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"rexus/internal/backup"
)

// backupsOn answers 404 (with the reason) when backups aren't switched on.
func (s *Server) backupsOn(w http.ResponseWriter) bool {
	if !s.settings.Get().BackupEnabled {
		writeError(w, http.StatusNotFound, "backups are switched off — turn them on in Settings → Modules")
		return false
	}
	return true
}

// handleListBackups is the Backups page: the status and the last few backups that were made.
func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.backupsOn(w) {
		return
	}
	st, err := s.backups.Status(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	recs, err := s.store.ListBackupRecords(r.Context(), 20)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": st, "backups": recs})
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

// handleDownloadBackup makes a backup of the whole database and sends it as a file. Nothing is kept on the
// server. It is a POST (not a link) so the usual request check applies, and a failure comes back as an error
// message before any file bytes are sent, never as a half file.
func (s *Server) handleDownloadBackup(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) || !s.backupsOn(w) {
		return
	}
	// The server's normal write limit is a minute; a big database takes longer to dump and send.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(35 * time.Minute))

	d, err := s.backups.Create(r.Context(), &a.user.ID)
	if err != nil {
		switch {
		case errors.Is(err, backup.ErrBusy):
			writeError(w, http.StatusConflict, "a backup is already running")
		case errors.Is(err, backup.ErrNothingToBackUp):
			writeError(w, http.StatusBadRequest, err.Error())
		case r.Context().Err() != nil:
			// the browser went away; nobody is listening
		default:
			writeError(w, http.StatusInternalServerError, "backup failed: "+err.Error())
		}
		return
	}
	defer d.Close()
	f, err := os.Open(d.Path)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer f.Close()

	s.audit(r, a, "backup.download", "backup", d.Name, map[string]any{"size_bytes": d.Size})
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", `attachment; filename="`+d.Name+`"`)
	h.Set("Content-Length", strconv.FormatInt(d.Size, 10))
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, f); err != nil {
		s.log.Warn("backup download interrupted", "file", d.Name, "err", err)
	}
}
