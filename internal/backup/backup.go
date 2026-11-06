// Package backup makes a copy of the database (pg_dump) for the owner or an admin to download, and restores
// one into an empty database. Nothing is kept on the server: the copy is made in a temporary file, handed to
// the person who asked, and deleted. Vault secrets inside are still encrypted with REXUS_MASTER_KEY.
package backup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

var (
	ErrBusy     = errors.New("a backup or restore is already running")
	ErrNotEmpty = errors.New("this database already has data — a restore only works into an empty database, so it can never overwrite live data")
	// A backup of an empty database is worse than none.
	ErrNothingToBackUp = errors.New("there is nothing to back up yet — Rexus has no accounts or data")
)

const (
	dumpTimeout = 30 * time.Minute
	recordKeep  = 90 * 24 * time.Hour
	// StaleAfter is how old the last good backup can get before the indicator turns yellow. Backups are taken by
	// hand, so this is a nudge, not an alarm.
	StaleAfter = 7 * 24 * time.Hour

	timeLayout = "20060102-150405"
)

type Service struct {
	st    *store.Store
	log   *slog.Logger
	dbURL string

	// Names of the PostgreSQL tools (overridden in tests).
	pgDump, pgRestore string

	mu      sync.Mutex // held while a backup or restore runs
	running atomic.Bool
}

func New(st *store.Store, log *slog.Logger, databaseURL string) *Service {
	return &Service{st: st, log: log, dbURL: databaseURL, pgDump: "pg_dump", pgRestore: "pg_restore"}
}

// Running reports whether a backup is being made right now.
func (s *Service) Running() bool { return s.running.Load() }

// Dump is a finished backup in a temporary file, waiting to be sent. Close deletes it.
type Dump struct {
	Path string
	Name string // rexus-YYYYMMDD-HHMMSS.dump (UTC)
	Size int64
}

func (d *Dump) Close() { os.Remove(d.Path) }

// Create makes a backup now and waits for it. The attempt, good or bad, is recorded in the history. The caller
// sends the file and then calls Close.
func (s *Service) Create(ctx context.Context, by *string) (*Dump, error) {
	if !s.mu.TryLock() {
		return nil, ErrBusy
	}
	defer s.mu.Unlock()
	if empty, err := s.DatabaseIsEmpty(ctx); err == nil && empty {
		return nil, ErrNothingToBackUp
	}
	s.running.Store(true)
	defer s.running.Store(false)

	started := time.Now()
	name := "rexus-" + started.UTC().Format(timeLayout) + ".dump"
	tmp, err := os.CreateTemp("", "rexus-backup-*.partial") // created 0600: the file holds password hashes and encrypted secrets
	if err != nil {
		return nil, fmt.Errorf("can't make a temporary file for the backup: %v", err)
	}
	tmp.Close()
	size, err := s.dump(ctx, tmp.Name())
	if err != nil && ctx.Err() != nil {
		os.Remove(tmp.Name())
		return nil, ctx.Err() // cancelled (the browser went away, or shutting down): not a failure worth recording
	}

	finished := time.Now()
	rec := &store.BackupRecord{Trigger: "manual", StartedAt: started, FinishedAt: &finished}
	if err != nil {
		os.Remove(tmp.Name())
		msg := clip(err.Error(), 500)
		rec.Status, rec.Error = "failed", &msg
	} else {
		rec.Status, rec.FileName, rec.SizeBytes = "success", &name, &size
	}
	if rerr := s.st.AddBackupRecord(context.WithoutCancel(ctx), rec, by); rerr != nil {
		s.log.Error("backup: record result", "err", rerr)
	}
	if perr := s.st.PruneBackupRecords(context.WithoutCancel(ctx), recordKeep); perr != nil {
		s.log.Warn("backup: prune history", "err", perr)
	}
	if err != nil {
		s.log.Error("backup failed", "err", err)
		return nil, err
	}
	s.log.Info("backup made", "file", name, "bytes", size)
	return &Dump{Path: tmp.Name(), Name: name, Size: size}, nil
}

// ---- status ----

type Status struct {
	Enabled       bool       `json:"enabled"`
	Running       bool       `json:"running"`
	State         string     `json:"state"` // ok | stale | failed | none
	LastSuccessAt *time.Time `json:"last_success_at"`
	LastAttemptAt *time.Time `json:"last_attempt_at"`
	LastError     *string    `json:"last_error"`
}

// State is the traffic light shown in the top bar:
//
//	failed — the latest attempt failed (red)
//	none   — no backup has ever been made (red)
//	stale  — the last good backup is older than a week (yellow)
//	ok     — everything is fine (green)
func State(now time.Time, lastSuccess *time.Time, lastAttemptFailed, anyAttempt bool) string {
	switch {
	case lastAttemptFailed:
		return "failed"
	case !anyAttempt:
		return "none"
	case lastSuccess != nil && now.Sub(*lastSuccess) > StaleAfter:
		return "stale"
	}
	return "ok"
}

func (s *Service) Status(ctx context.Context) (*Status, error) {
	st := &Status{Enabled: true, Running: s.running.Load()}
	last, err := s.st.LastBackupAttempt(ctx)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	good, err := s.st.LastBackupSuccess(ctx)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if last != nil {
		st.LastAttemptAt = &last.StartedAt
		if last.Status == "failed" {
			st.LastError = last.Error
		}
	}
	if good != nil {
		st.LastSuccessAt = &good.StartedAt
	}
	st.State = State(time.Now(), st.LastSuccessAt, last != nil && last.Status == "failed", last != nil)
	return st, nil
}

// ---- restore ----

// DatabaseIsEmpty reports whether Rexus has no data yet: no users table, or no users in it.
func (s *Service) DatabaseIsEmpty(ctx context.Context) (bool, error) {
	var hasTable bool
	if err := s.st.Pool.QueryRow(ctx, `SELECT to_regclass('public.users') IS NOT NULL`).Scan(&hasTable); err != nil {
		return false, err
	}
	if !hasTable {
		return true, nil
	}
	var any bool
	if err := s.st.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&any); err != nil {
		return false, err
	}
	return !any, nil
}

// Restore loads the backup at path into the (empty) database. After it
// returns, the caller should reset its connection pool and run migrations.
func (s *Service) Restore(ctx context.Context, path string) error {
	if !s.mu.TryLock() {
		return ErrBusy
	}
	defer s.mu.Unlock()

	empty, err := s.DatabaseIsEmpty(ctx)
	if err != nil {
		return err
	}
	if !empty {
		return ErrNotEmpty
	}
	if err := s.verify(ctx, path); err != nil {
		return fmt.Errorf("this isn't a usable Rexus backup: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, dumpTimeout)
	defer cancel()
	return s.restoreFile(ctx, path)
}

// CheckMasterKey tries to decrypt one stored secret with the current master
// key. checked is false when there is nothing encrypted to test; err is set
// when the data can't be read — usually because this isn't the key that
// encrypted it.
func CheckMasterKey(ctx context.Context, st *store.Store, keys *crypto.Keyring) (checked bool, err error) {
	var secretID string
	var version int
	var ct, wrapped []byte
	e := st.Pool.QueryRow(ctx, `SELECT secret_id::text, version, ciphertext, wrapped_key FROM secret_versions LIMIT 1`).
		Scan(&secretID, &version, &ct, &wrapped)
	if e == nil {
		_, err := keys.Open(ct, wrapped, crypto.SecretAAD(secretID, version))
		return true, err
	}
	var userID string
	var totp []byte
	if e := st.Pool.QueryRow(ctx, `SELECT id::text, totp_secret FROM users WHERE totp_secret IS NOT NULL LIMIT 1`).Scan(&userID, &totp); e == nil {
		_, err := keys.Decrypt(totp, crypto.TOTPAAD(userID))
		return true, err
	}
	return false, nil
}

// KeyWarning is the message shown after a restore when the data can't be decrypted.
const KeyWarning = "The restored data can't be decrypted with the current REXUS_MASTER_KEY. Vault secrets, 2FA and alert channels will not work until you set REXUS_MASTER_KEY to the key of the instance that made this backup."
