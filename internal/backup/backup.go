// Package backup takes, rotates and restores database backups: plain
// pg_dump files in a folder you choose (a local disk, an external drive, a
// pendrive). Vault secrets inside are still encrypted with REXUS_MASTER_KEY.
package backup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"rexus/internal/alerts"
	"rexus/internal/crypto"
	"rexus/internal/store"
)

var (
	ErrBusy     = errors.New("a backup or restore is already running")
	ErrNotEmpty = errors.New("this database already has data — a restore only works into an empty database, so it can never overwrite live data")
	ErrDisabled = errors.New("backups are disabled (set REXUS_BACKUP_ENABLED=true)")
	// A backup of an empty database is worse than none: after a wipe it would become the
	// "newest" backup and be the one offered for restore.
	ErrNothingToBackUp = errors.New("there is nothing to back up yet — Rexus has no accounts or data")
)

const (
	DefaultIntervalMinutes = 360 // 6 hours
	DefaultKeep            = 28

	startDelay  = 30 * time.Second
	tickEvery   = 10 * time.Second
	failedRetry = 15 * time.Minute // after a failed attempt, try again sooner than the normal interval
	dumpTimeout = 30 * time.Minute
	recordKeep  = 90 * 24 * time.Hour
)

// AllowedIntervals are the choices in the UI, in minutes. 0 means "manual only".
var AllowedIntervals = []int{0, 15, 60, 360, 1440}

type Options struct {
	Enabled     bool
	Dir         string
	DatabaseURL string
}

type Service struct {
	st  *store.Store
	log *slog.Logger
	al  *alerts.Service // may be nil

	enabled bool
	dir     string
	dbURL   string

	// Names of the PostgreSQL tools (overridden in tests).
	pgDump, pgRestore string

	mu      sync.Mutex // held while a backup or restore runs
	running atomic.Bool
	ctx     context.Context
	wg      sync.WaitGroup
}

func New(st *store.Store, log *slog.Logger, al *alerts.Service, o Options) *Service {
	return &Service{st: st, log: log, al: al, enabled: o.Enabled, dir: o.Dir, dbURL: o.DatabaseURL,
		pgDump: "pg_dump", pgRestore: "pg_restore", ctx: context.Background()}
}

func (s *Service) Enabled() bool { return s.enabled }
func (s *Service) Dir() string   { return s.dir }

func (s *Service) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		s.log.Warn("backup: shutdown timed out with a backup still running")
	}
}

// ---- settings ----

type Settings struct {
	IntervalMinutes int `json:"interval_minutes"` // 0 = manual only
	Keep            int `json:"keep"`             // how many backup files to keep
}

func ValidateSettings(st Settings) error {
	okInterval := false
	for _, v := range AllowedIntervals {
		if st.IntervalMinutes == v {
			okInterval = true
		}
	}
	if !okInterval {
		return errors.New("interval must be 15 minutes, 1 hour, 6 hours, 24 hours or manual only")
	}
	if st.Keep < 1 || st.Keep > 500 {
		return errors.New("keep between 1 and 500 backups")
	}
	return nil
}

func (s *Service) Settings(ctx context.Context) Settings {
	st := Settings{IntervalMinutes: DefaultIntervalMinutes, Keep: DefaultKeep}
	var iv int
	if ok, _ := s.st.GetSetting(ctx, "backup.interval_minutes", &iv); ok && ValidateSettings(Settings{iv, 1}) == nil {
		st.IntervalMinutes = iv
	}
	var keep int
	if ok, _ := s.st.GetSetting(ctx, "backup.keep", &keep); ok && keep >= 1 && keep <= 500 {
		st.Keep = keep
	}
	return st
}

func (s *Service) SetSettings(ctx context.Context, st Settings) error {
	if err := ValidateSettings(st); err != nil {
		return err
	}
	if err := s.st.SetSetting(ctx, "backup.interval_minutes", st.IntervalMinutes); err != nil {
		return err
	}
	return s.st.SetSetting(ctx, "backup.keep", st.Keep)
}

// ---- running a backup ----

// Run takes a backup now and waits for it. It records the attempt, rotates
// old files, and sends the "backup failed" alert when backups start failing.
func (s *Service) Run(ctx context.Context, trigger string, by *string) (*store.BackupRecord, error) {
	if !s.mu.TryLock() {
		return nil, ErrBusy
	}
	defer s.mu.Unlock()
	return s.runLocked(ctx, trigger, by)
}

// Trigger starts a backup in the background (the "Backup now" button, and the schedule).
func (s *Service) Trigger(trigger string, by *string) error {
	if !s.enabled {
		return ErrDisabled
	}
	if !s.mu.TryLock() {
		return ErrBusy
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.mu.Unlock()
		s.runLocked(s.ctx, trigger, by)
	}()
	return nil
}

func (s *Service) runLocked(ctx context.Context, trigger string, by *string) (*store.BackupRecord, error) {
	if empty, err := s.DatabaseIsEmpty(ctx); err == nil && empty {
		return nil, ErrNothingToBackUp
	}
	s.running.Store(true)
	defer s.running.Store(false)

	started := time.Now()
	prev, _ := s.st.LastBackupAttempt(ctx)
	name := s.freeName(started)
	size, err := s.dumpToFile(ctx, name)
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err() // shutting down mid-backup: not a failure worth recording
	}

	finished := time.Now()
	rec := &store.BackupRecord{Trigger: trigger, StartedAt: started, FinishedAt: &finished}
	if err != nil {
		msg := clip(err.Error(), 500)
		rec.Status, rec.Error = "failed", &msg
	} else {
		rec.Status, rec.FileName, rec.SizeBytes = "success", &name, &size
	}
	if rerr := s.st.AddBackupRecord(context.Background(), rec, by); rerr != nil {
		s.log.Error("backup: record result", "err", rerr)
	}

	if err != nil {
		s.log.Error("backup failed", "trigger", trigger, "err", err)
		// One alert when backups start failing — not one per retry.
		if s.al != nil && (prev == nil || prev.Status != "failed") {
			var lastGood *time.Time
			if g, gerr := s.st.LastBackupSuccess(context.Background()); gerr == nil {
				lastGood = &g.StartedAt
			}
			s.al.BackupFailed(*rec.Error, lastGood)
		}
		return rec, err
	}

	s.log.Info("backup done", "file", name, "bytes", size, "trigger", trigger)
	if removed, rerr := s.Rotate(s.Settings(ctx).Keep); rerr != nil {
		s.log.Warn("backup: rotation problem", "err", rerr)
	} else if len(removed) > 0 {
		s.log.Info("backup: removed old backups", "count", len(removed))
	}
	return rec, nil
}

// ---- schedule ----

// Start runs scheduled backups until ctx is cancelled. A backup is due when
// the interval has passed since the last attempt; after a failure it retries
// within 15 minutes rather than waiting a full interval.
func (s *Service) Start(ctx context.Context) {
	s.ctx = ctx
	if !s.enabled {
		return
	}
	s.cleanPartials()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(tickEvery)
		defer ticker.Stop()
		begin := time.Now().Add(startDelay)
		lastPrune := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if time.Now().Before(begin) {
					continue
				}
				s.tick(ctx)
				if time.Since(lastPrune) > time.Hour {
					lastPrune = time.Now()
					if err := s.st.PruneBackupRecords(ctx, recordKeep); err != nil {
						s.log.Error("backup: prune history", "err", err)
					}
				}
			}
		}
	}()
	s.log.Info("backups enabled", "folder", s.dir)
}

func (s *Service) tick(ctx context.Context) {
	set := s.Settings(ctx)
	if set.IntervalMinutes == 0 {
		return
	}
	last, err := s.st.LastBackupAttempt(ctx)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.log.Error("backup: read history", "err", err)
		return
	}
	if due, _ := nextRun(last, set.IntervalMinutes, time.Now()); !due {
		return
	}
	// A brand-new or freshly wiped instance has nothing worth saving yet.
	if empty, err := s.DatabaseIsEmpty(ctx); err != nil || empty {
		return
	}
	if err := s.Trigger("scheduled", nil); err != nil && !errors.Is(err, ErrBusy) {
		s.log.Error("backup: start scheduled backup", "err", err)
	}
}

// nextRun says whether a scheduled backup is due, and when the next one is.
func nextRun(last *store.BackupRecord, intervalMin int, now time.Time) (due bool, at time.Time) {
	if intervalMin == 0 {
		return false, time.Time{}
	}
	if last == nil {
		return true, now
	}
	wait := time.Duration(intervalMin) * time.Minute
	if last.Status == "failed" && wait > failedRetry {
		wait = failedRetry
	}
	at = last.StartedAt.Add(wait)
	return !now.Before(at), at
}

// ---- status ----

type Status struct {
	Enabled       bool       `json:"enabled"`
	Dir           string     `json:"dir"`
	Settings      Settings   `json:"settings"`
	Running       bool       `json:"running"`
	State         string     `json:"state"` // ok | stale | failed | none
	LastSuccessAt *time.Time `json:"last_success_at"`
	LastAttemptAt *time.Time `json:"last_attempt_at"`
	LastError     *string    `json:"last_error"`
	NextRunAt     *time.Time `json:"next_run_at"`
	Files         int        `json:"files"`
}

// State is the traffic light shown in the top bar:
//
//	failed — the latest attempt failed (red)
//	none   — no backup has ever run (red)
//	stale  — the last good backup is older than twice the interval (yellow)
//	ok     — everything is fine (green)
//
// A "manual only" schedule is never stale.
func State(now time.Time, intervalMin int, lastSuccess *time.Time, lastAttemptFailed, anyAttempt bool) string {
	switch {
	case lastAttemptFailed:
		return "failed"
	case !anyAttempt:
		return "none"
	case intervalMin > 0 && lastSuccess != nil && now.Sub(*lastSuccess) > 2*time.Duration(intervalMin)*time.Minute:
		return "stale"
	}
	return "ok"
}

func (s *Service) Status(ctx context.Context) (*Status, error) {
	st := &Status{Enabled: s.enabled, Dir: s.dir, Settings: s.Settings(ctx), Running: s.running.Load()}
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
	st.State = State(time.Now(), st.Settings.IntervalMinutes, st.LastSuccessAt, last != nil && last.Status == "failed", last != nil)
	if s.enabled {
		if _, at := nextRun(last, st.Settings.IntervalMinutes, time.Now()); !at.IsZero() {
			if at.Before(time.Now()) {
				at = time.Now()
			}
			st.NextRunAt = &at
		}
	}
	if files, err := s.Files(); err == nil {
		st.Files = len(files)
	}
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
