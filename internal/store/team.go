package store

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// ---- invites ----

type Invite struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	InvitedBy *string   `json:"invited_by"` // inviter's email
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// CreateInvite stores a new invite. Any open invite for the same email is
// replaced (so "re-invite" gives a fresh link). A user with that email must
// not already exist.
func (s *Store) CreateInvite(ctx context.Context, email, role string, tokenHash []byte, invitedBy string, expires time.Time) (*Invite, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1))`, email).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM invites WHERE lower(email) = lower($1) AND used_at IS NULL`, email); err != nil {
		return nil, err
	}
	inv := &Invite{}
	err = tx.QueryRow(ctx, `INSERT INTO invites (email, role, token_hash, invited_by, expires_at)
		VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, expires_at, created_at`,
		email, role, tokenHash, invitedBy, expires).Scan(&inv.ID, &inv.Email, &inv.Role, &inv.ExpiresAt, &inv.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return inv, tx.Commit(ctx)
}

// ListInvites returns open (unused, unexpired) invites, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]*Invite, error) {
	rows, err := s.Pool.Query(ctx, `SELECT i.id, i.email, i.role, u.email, i.expires_at, i.created_at
		FROM invites i LEFT JOIN users u ON u.id = i.invited_by
		WHERE i.used_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Invite{}
	for rows.Next() {
		i := &Invite{}
		if err := rows.Scan(&i.ID, &i.Email, &i.Role, &i.InvitedBy, &i.ExpiresAt, &i.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) RevokeInvite(ctx context.Context, id string) (*Invite, error) {
	i := &Invite{}
	err := s.Pool.QueryRow(ctx, `DELETE FROM invites WHERE id = $1 AND used_at IS NULL
		RETURNING id, email, role, expires_at, created_at`, id).Scan(&i.ID, &i.Email, &i.Role, &i.ExpiresAt, &i.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return i, nil
}

// InviteByTokenHash returns the invite only if it is unused and unexpired.
func (s *Store) InviteByTokenHash(ctx context.Context, tokenHash []byte) (*Invite, error) {
	i := &Invite{}
	err := s.Pool.QueryRow(ctx, `SELECT id, email, role, expires_at, created_at FROM invites
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, tokenHash).
		Scan(&i.ID, &i.Email, &i.Role, &i.ExpiresAt, &i.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return i, nil
}

// AcceptInvite creates the user and burns the invite in one transaction, so a
// link can never be used twice.
func (s *Store) AcceptInvite(ctx context.Context, tokenHash []byte, name, passwordHash string) (*User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var id, email, role string
	err = tx.QueryRow(ctx, `SELECT id, email, role FROM invites
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, tokenHash).Scan(&id, &email, &role)
	if err != nil {
		return nil, notFound(err)
	}
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users (email, name, password_hash, role)
		VALUES ($1, $2, $3, $4) RETURNING `+userCols, email, strings.TrimSpace(name), passwordHash, role))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE invites SET used_at = now() WHERE id = $1`, id); err != nil {
		return nil, err
	}
	return u, tx.Commit(ctx)
}

// ---- users ----

func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+userCols+` FROM users
		ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, lower(email)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) SetUserRole(ctx context.Context, id, role string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE users SET role = $2, updated_at = now() WHERE id = $1 AND role <> 'owner'`, id, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetUserStatus(ctx context.Context, id, status string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND role <> 'owner'`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteUser removes a user. Their audit entries stay (the email is kept in
// the entry); anything they created keeps existing with no owner.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1 AND role <> 'owner'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeOtherSessions logs a user out everywhere except keepID.
func (s *Store) RevokeOtherSessions(ctx context.Context, userID, keepID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE sessions SET revoked_at = now()
		WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, userID, keepID)
	return err
}

// TransferOwnership makes toID the owner and demotes fromID to admin, atomically.
func (s *Store) TransferOwnership(ctx context.Context, fromID, toID string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, ownerLockID); err != nil {
		return err
	}
	var fromRole string
	if err := tx.QueryRow(ctx, `SELECT role FROM users WHERE id = $1 FOR UPDATE`, fromID).Scan(&fromRole); err != nil {
		return notFound(err)
	}
	if fromRole != "owner" {
		return ErrNotFound
	}
	var toStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM users WHERE id = $1 FOR UPDATE`, toID).Scan(&toStatus); err != nil {
		return notFound(err)
	}
	if toStatus != "active" {
		return ErrNotFound
	}
	// Demote first: the single-owner unique index is checked per statement.
	if _, err := tx.Exec(ctx, `UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, fromID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET role = 'owner', updated_at = now() WHERE id = $1`, toID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---- password reset links ----

// CreatePasswordReset replaces any open reset link for the user.
func (s *Store) CreatePasswordReset(ctx context.Context, userID string, tokenHash []byte, createdBy string, expires time.Time) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO password_resets (user_id, token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4)`, userID, tokenHash, createdBy, expires); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ResetEmail returns the email a valid reset link belongs to.
func (s *Store) ResetEmail(ctx context.Context, tokenHash []byte) (string, error) {
	var email string
	err := s.Pool.QueryRow(ctx, `SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id
		WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active'`, tokenHash).Scan(&email)
	return email, notFound(err)
}

// UsePasswordReset sets the new password, burns the link and logs the user
// out everywhere — all in one transaction.
func (s *Store) UsePasswordReset(ctx context.Context, tokenHash []byte, passwordHash string) (*User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var userID string
	err = tx.QueryRow(ctx, `SELECT user_id FROM password_resets
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, tokenHash).Scan(&userID)
	if err != nil {
		return nil, notFound(err)
	}
	tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND status = 'active'`, userID, passwordHash)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, tokenHash); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
		return nil, err
	}
	u, err := scanUser(tx.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, userID))
	if err != nil {
		return nil, err
	}
	return u, tx.Commit(ctx)
}

// ---- audit log ----

type AuditRow struct {
	ID         int64          `json:"id"`
	At         time.Time      `json:"at"`
	Actor      string         `json:"actor"`
	Action     string         `json:"action"`
	TargetType *string        `json:"target_type"`
	TargetID   *string        `json:"target_id"`
	IP         string         `json:"ip"`
	Details    map[string]any `json:"details"`
}

// ListAudit returns entries newest first. q matches the action prefix or part
// of the actor; before is an entry ID for paging (0 = from the newest).
func (s *Store) ListAudit(ctx context.Context, q string, before int64, limit int) ([]*AuditRow, error) {
	where := []string{"true"}
	args := []any{}
	if before > 0 {
		args = append(args, before)
		where = append(where, "id < $1")
	}
	if q = strings.TrimSpace(q); q != "" {
		args = append(args, q)
		n := len(args)
		p := "$" + strconv.Itoa(n) + "::text"
		where = append(where, "(action ILIKE "+p+" || '%' OR actor ILIKE '%' || "+p+" || '%')")
	}
	args = append(args, limit)
	rows, err := s.Pool.Query(ctx, `SELECT id, at, actor, action, target_type, target_id, ip, details
		FROM audit_log WHERE `+strings.Join(where, " AND ")+` ORDER BY id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*AuditRow{}
	for rows.Next() {
		a := &AuditRow{}
		if err := rows.Scan(&a.ID, &a.At, &a.Actor, &a.Action, &a.TargetType, &a.TargetID, &a.IP, &a.Details); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
