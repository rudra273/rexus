// Package store holds all database queries.
package store

import (
	"context"
	"errors"
	"log/slog"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrConflict    = errors.New("already exists")
	ErrOwnerExists = errors.New("an owner already exists")
)

type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{Pool: pool} }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsUUID reports whether s looks like a UUID (checked before querying so a
// bad URL param returns 404 instead of a Postgres syntax error).
func IsUUID(s string) bool { return uuidRe.MatchString(s) }

// AuditEntry is one row in the audit log.
type AuditEntry struct {
	ActorUserID *string
	Actor       string // email, or "cli" / "system"
	Action      string // e.g. "auth.login", "project.create"
	TargetType  string
	TargetID    string
	IP          string
	Details     map[string]any
	ProjectID   *string // the project the entry is about, if any (who may see it)
}

// Audit writes an audit-log entry. Failures are logged, never returned:
// an audit write must not break the action that triggered it.
func (s *Store) Audit(ctx context.Context, e AuditEntry) {
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO audit_log (actor_user_id, actor, action, target_type, target_id, ip, details, project_id)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8)`,
		e.ActorUserID, e.Actor, e.Action, e.TargetType, e.TargetID, e.IP, e.Details, e.ProjectID)
	if err != nil {
		slog.Error("audit log write failed", "action", e.Action, "err", err)
	}
}
