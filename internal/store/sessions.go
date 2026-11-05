package store

import (
	"context"
	"time"
)

type Session struct {
	ID          string
	UserID      string
	MFAVerified bool
	ExpiresAt   time.Time
	LastSeenAt  time.Time
}

func (s *Store) CreateSession(ctx context.Context, userID string, tokenHash []byte, mfaVerified bool, ip, ua string, expires time.Time) error {
	if len(ua) > 300 {
		ua = ua[:300]
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO sessions (user_id, token_hash, mfa_verified, ip, user_agent, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, userID, tokenHash, mfaVerified, ip, ua, expires)
	return err
}

// SessionByToken returns a live (not revoked, not expired) session and its user.
func (s *Store) SessionByToken(ctx context.Context, tokenHash []byte) (*Session, *User, error) {
	row := s.Pool.QueryRow(ctx, `SELECT s.id, s.user_id, s.mfa_verified, s.expires_at, s.last_seen_at,
			u.id, u.email, u.name, u.password_hash, u.role, u.status, u.totp_secret, u.totp_pending_secret,
			u.totp_enabled, u.totp_last_step, u.last_login_at, u.created_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, tokenHash)
	sess := &Session{}
	u := &User{}
	err := row.Scan(&sess.ID, &sess.UserID, &sess.MFAVerified, &sess.ExpiresAt, &sess.LastSeenAt,
		&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &u.Status, &u.TOTPSecret, &u.TOTPPendingSecret,
		&u.TOTPEnabled, &u.TOTPLastStep, &u.LastLoginAt, &u.CreatedAt)
	if err != nil {
		return nil, nil, notFound(err)
	}
	return sess, u, nil
}

func (s *Store) MarkSessionMFA(ctx context.Context, sessionID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE sessions SET mfa_verified = true WHERE id = $1`, sessionID)
	return err
}

// TouchSession slides the session expiry forward on activity.
func (s *Store) TouchSession(ctx context.Context, sessionID string, expires time.Time) error {
	_, err := s.Pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1`, sessionID, expires)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, sessionID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID)
	return err
}

func (s *Store) RevokeUserSessions(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return err
}

// RevokeNonOwnerSessions logs everyone except the owner out (lockdown mode).
func (s *Store) RevokeNonOwnerSessions(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE sessions SET revoked_at = now()
		WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE role <> 'owner')`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// PruneSessions deletes sessions that expired or were revoked over a week ago.
func (s *Store) PruneSessions(ctx context.Context) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sessions
		WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`)
	return err
}
