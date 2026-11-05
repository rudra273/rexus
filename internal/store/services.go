package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// A Service is an optional organizational scope inside a project (frontend,
// backend, worker…). It provisions nothing; it only groups secrets, jobs and
// health checks. Resources without a service belong to the project directly.
type Service struct {
	ID            string    `json:"id"`
	ProjectID     string    `json:"project_id"`
	ProjectKey    string    `json:"project_key"`
	Key           string    `json:"key"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	RepositoryURL *string   `json:"repository_url"`
	RootDirectory *string   `json:"root_directory"`
	SecretCount   int       `json:"secret_count"`
	JobCount      int       `json:"job_count"`
	CheckCount    int       `json:"check_count"`
	FailingJobs   int       `json:"failing_jobs"`
	HealthStatus  string    `json:"health_status"` // like Project.HealthStatus, over this service's checks
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

var (
	// ErrInUse: the row is still referenced (e.g. a service that has secrets).
	ErrInUse = errors.New("still in use")
	// ErrInvalidScope: a service or environment doesn't belong to the resource's project.
	ErrInvalidScope = errors.New("the service or environment does not belong to this project")
)

func isFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

var ErrInvalidServiceKey = errors.New("service key must be 2–40 characters: lowercase letters, numbers and dashes, starting with a letter and not ending with a dash")

// NormalizeServiceKey lowercases and validates a key (same rule as project keys).
func NormalizeServiceKey(key string) (string, error) {
	key = strings.ToLower(strings.TrimSpace(key))
	if !projectKeyRe.MatchString(key) {
		return "", ErrInvalidServiceKey
	}
	return key, nil
}

const serviceSelect = `SELECT sv.id, sv.project_id, p.key, sv.key, sv.name, sv.description, sv.repository_url,
	sv.root_directory, sv.created_at, sv.updated_at,
	(SELECT count(*) FROM secrets s WHERE s.service_id = sv.id),
	(SELECT count(*) FROM jobs j WHERE j.service_id = sv.id),
	(SELECT count(*) FROM jobs j WHERE j.service_id = sv.id AND j.enabled AND j.last_status = 'failed'),
	(SELECT count(*) FROM health_checks c WHERE c.service_id = sv.id),
	COALESCE((SELECT CASE WHEN bool_or(c.status = 'down') THEN 'down'
			WHEN bool_or(c.status = 'degraded') THEN 'degraded'
			WHEN bool_or(c.status = 'up') THEN 'up' ELSE 'unknown' END
		FROM health_checks c WHERE c.service_id = sv.id AND c.enabled HAVING count(*) > 0), 'none')
	FROM services sv JOIN projects p ON p.id = sv.project_id`

func scanService(row interface{ Scan(...any) error }) (*Service, error) {
	x := &Service{}
	err := row.Scan(&x.ID, &x.ProjectID, &x.ProjectKey, &x.Key, &x.Name, &x.Description, &x.RepositoryURL,
		&x.RootDirectory, &x.CreatedAt, &x.UpdatedAt, &x.SecretCount, &x.JobCount, &x.FailingJobs, &x.CheckCount,
		&x.HealthStatus)
	if err != nil {
		return nil, notFound(err)
	}
	return x, nil
}

func (s *Store) ListServices(ctx context.Context, projectID string) ([]*Service, error) {
	rows, err := s.Pool.Query(ctx, serviceSelect+` WHERE sv.project_id = $1 ORDER BY sv.position, sv.name`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Service{}
	for rows.Next() {
		x, err := scanService(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) ServiceByID(ctx context.Context, id string) (*Service, error) {
	return scanService(s.Pool.QueryRow(ctx, serviceSelect+` WHERE sv.id = $1`, id))
}

func (s *Store) ServiceByKey(ctx context.Context, projectID, key string) (*Service, error) {
	return scanService(s.Pool.QueryRow(ctx, serviceSelect+` WHERE sv.project_id = $1 AND sv.key = $2`,
		projectID, strings.ToLower(key)))
}

func (s *Store) CreateService(ctx context.Context, x *Service, createdBy string) (*Service, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO services (project_id, key, name, description, repository_url,
			root_directory, position, created_by)
		VALUES ($1, $2, $3, $4, $5, $6,
			COALESCE((SELECT max(position) + 1 FROM services WHERE project_id = $1), 0), $7)
		RETURNING id`,
		x.ProjectID, x.Key, x.Name, x.Description, x.RepositoryURL, x.RootDirectory, createdBy).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.ServiceByID(ctx, id)
}

func (s *Store) UpdateService(ctx context.Context, x *Service) (*Service, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE services SET key = $2, name = $3, description = $4, repository_url = $5,
			root_directory = $6, updated_at = now()
		WHERE id = $1`, x.ID, x.Key, x.Name, x.Description, x.RepositoryURL, x.RootDirectory)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.ServiceByID(ctx, x.ID)
}

// DeleteService removes an empty service. A service that still has secrets,
// jobs or checks is never deleted with them: the foreign keys reject it and
// this returns ErrInUse.
func (s *Store) DeleteService(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM services WHERE id = $1`, id)
	if err != nil {
		if isFKViolation(err) {
			return ErrInUse
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- scope filters ----

// ScopeFilter narrows a list by service or environment:
// "" = all, "-" (ScopeNone) = only resources without one, otherwise an ID.
type ScopeFilter string

const ScopeNone ScopeFilter = "-"

// Valid reports whether f is "", "-" or a UUID.
func (f ScopeFilter) Valid() bool { return f == "" || f == ScopeNone || IsUUID(string(f)) }

// where returns the SQL condition for column col, using placeholder n for an ID.
// ok is false when the filter is "all".
func (f ScopeFilter) where(col string, n int) (cond string, arg any, ok bool) {
	switch f {
	case "":
		return "", nil, false
	case ScopeNone:
		return col + " IS NULL", nil, true
	}
	return fmt.Sprintf("%s = $%d", col, n), string(f), true
}

// filterBuilder collects WHERE conditions with numbered placeholders.
type filterBuilder struct {
	where []string
	args  []any
}

func (b *filterBuilder) add(cond string, v any) {
	b.args = append(b.args, v)
	b.where = append(b.where, strings.ReplaceAll(cond, "?", fmt.Sprintf("$%d", len(b.args))))
}

func (b *filterBuilder) scope(col string, f ScopeFilter) {
	cond, arg, ok := f.where(col, len(b.args)+1)
	if !ok {
		return
	}
	if arg != nil {
		b.args = append(b.args, arg)
	}
	b.where = append(b.where, cond)
}

func (b *filterBuilder) sql() string {
	if len(b.where) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(b.where, " AND ")
}

// writeErr maps a constraint violation on insert/update to a store error.
func writeErr(err error) error {
	switch {
	case err == nil:
		return nil
	case isUniqueViolation(err):
		return ErrConflict
	case isFKViolation(err):
		return ErrInvalidScope
	}
	return err
}
