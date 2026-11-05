package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type User struct {
	ID                string     `json:"id"`
	Email             string     `json:"email"`
	Name              string     `json:"name"`
	Role              string     `json:"role"`
	Status            string     `json:"status"`
	TOTPEnabled       bool       `json:"totp_enabled"`
	LastLoginAt       *time.Time `json:"last_login_at"`
	CreatedAt         time.Time  `json:"created_at"`
	AllProjects       bool       `json:"all_projects"` // admins: sees every project that is not owner-only
	PasswordHash      string     `json:"-"`
	TOTPSecret        []byte     `json:"-"`
	TOTPPendingSecret []byte     `json:"-"`
	TOTPLastStep      int64      `json:"-"`
}

const userCols = `id, email, name, password_hash, role, status, totp_secret, totp_pending_secret,
	totp_enabled, totp_last_step, last_login_at, created_at, all_projects`

func scanUser(row pgx.Row) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &u.Status,
		&u.TOTPSecret, &u.TOTPPendingSecret, &u.TOTPEnabled, &u.TOTPLastStep, &u.LastLoginAt, &u.CreatedAt, &u.AllProjects)
	if err != nil {
		return nil, notFound(err)
	}
	return u, nil
}

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(s.Pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE lower(email) = lower($1)`, strings.TrimSpace(email)))
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.Pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id))
}

func (s *Store) Owner(ctx context.Context) (*User, error) {
	return scanUser(s.Pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE role = 'owner'`))
}

// OwnerExists is how Rexus decides setup mode vs normal mode on every boot:
// the app is stateless, the database is the source of truth.
func (s *Store) OwnerExists(ctx context.Context) (bool, error) {
	var exists bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`).Scan(&exists)
	return exists, err
}

// ownerLockID guards owner creation (plus the users_single_owner unique index).
const ownerLockID = 727_393_871

// CreateOwner creates the one and only owner inside a transaction. If two
// requests race, exactly one wins; the other gets ErrOwnerExists.
func (s *Store) CreateOwner(ctx context.Context, email, name, passwordHash string) (*User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, ownerLockID); err != nil {
		return nil, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrOwnerExists
	}
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users (email, name, password_hash, role)
		VALUES ($1, $2, $3, 'owner') RETURNING `+userCols, strings.TrimSpace(email), strings.TrimSpace(name), passwordHash))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrOwnerExists
		}
		return nil, err
	}
	return u, tx.Commit(ctx)
}

func (s *Store) SetPassword(ctx context.Context, userID, hash string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, userID, hash)
	return err
}

func (s *Store) SetTOTPPending(ctx context.Context, userID string, enc []byte) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET totp_pending_secret = $2, updated_at = now() WHERE id = $1`, userID, enc)
	return err
}

func (s *Store) EnableTOTP(ctx context.Context, userID string, enc []byte, step int64) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET totp_secret = $2, totp_pending_secret = NULL,
		totp_enabled = true, totp_last_step = $3, updated_at = now() WHERE id = $1`, userID, enc, step)
	return err
}

// ResetTOTP turns 2FA off for a user (owner reset, or user disabling it).
func (s *Store) ResetTOTP(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL,
		totp_enabled = false, totp_last_step = 0, updated_at = now() WHERE id = $1`, userID)
	return err
}

// UseTOTPStep records a used TOTP step. It returns false if the step was
// already used (replay) — the conditional update makes this race-safe.
func (s *Store) UseTOTPStep(ctx context.Context, userID string, step int64) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2`, userID, step)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) TouchLogin(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID)
	return err
}
