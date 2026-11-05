package store

import (
	"context"
	"time"
)

// ---- settings (key/value, edited in the UI) ----

// GetSetting reads a setting into dest. ok is false when it was never set.
func (s *Store) GetSetting(ctx context.Context, key string, dest any) (ok bool, err error) {
	err = s.Pool.QueryRow(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(dest)
	if err != nil {
		if notFound(err) == ErrNotFound {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *Store) SetSetting(ctx context.Context, key string, value any) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, value)
	return err
}

// ---- backup history ----

type BackupRecord struct {
	ID          string     `json:"id"`
	FileName    *string    `json:"file_name"`
	SizeBytes   *int64     `json:"size_bytes"`
	Status      string     `json:"status"` // success | failed
	Error       *string    `json:"error"`
	Trigger     string     `json:"trigger"`      // manual | scheduled
	TriggeredBy *string    `json:"triggered_by"` // email of who clicked "Backup now"
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
}

const backupSelect = `SELECT b.id, b.file_name, b.size_bytes, b.status, b.error, b.trigger, u.email, b.started_at, b.finished_at
	FROM backups b LEFT JOIN users u ON u.id = b.triggered_by`

func scanBackup(row interface{ Scan(...any) error }) (*BackupRecord, error) {
	r := &BackupRecord{}
	if err := row.Scan(&r.ID, &r.FileName, &r.SizeBytes, &r.Status, &r.Error, &r.Trigger, &r.TriggeredBy, &r.StartedAt, &r.FinishedAt); err != nil {
		return nil, notFound(err)
	}
	return r, nil
}

func (s *Store) AddBackupRecord(ctx context.Context, r *BackupRecord, triggeredByUserID *string) error {
	return s.Pool.QueryRow(ctx, `INSERT INTO backups (file_name, size_bytes, status, error, trigger, triggered_by, started_at, finished_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		r.FileName, r.SizeBytes, r.Status, r.Error, r.Trigger, triggeredByUserID, r.StartedAt, r.FinishedAt).Scan(&r.ID)
}

func (s *Store) ListBackupRecords(ctx context.Context, limit int) ([]*BackupRecord, error) {
	rows, err := s.Pool.Query(ctx, backupSelect+` ORDER BY b.started_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*BackupRecord{}
	for rows.Next() {
		r, err := scanBackup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LastBackupAttempt is the most recent attempt, successful or not (ErrNotFound if none).
func (s *Store) LastBackupAttempt(ctx context.Context) (*BackupRecord, error) {
	return scanBackup(s.Pool.QueryRow(ctx, backupSelect+` ORDER BY b.started_at DESC LIMIT 1`))
}

// LastBackupSuccess is the most recent successful backup (ErrNotFound if none).
func (s *Store) LastBackupSuccess(ctx context.Context) (*BackupRecord, error) {
	return scanBackup(s.Pool.QueryRow(ctx, backupSelect+` WHERE b.status = 'success' ORDER BY b.started_at DESC LIMIT 1`))
}

func (s *Store) PruneBackupRecords(ctx context.Context, olderThan time.Duration) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM backups WHERE started_at < $1`, time.Now().Add(-olderThan))
	return err
}
