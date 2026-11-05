package store

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

type Project struct {
	ID          string    `json:"id"`
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	JobCount    int       `json:"job_count"`
	FailingJobs int       `json:"failing_jobs"`
}

var projectKeyRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,38}[a-z0-9]$`)

var ErrInvalidKey = errors.New("project key must be 2–40 characters: lowercase letters, numbers and dashes, starting with a letter and not ending with a dash")

// NormalizeProjectKey lowercases and validates a key. Keys are stored
// lowercase, so "Acme-Web" and "acme-web" are the same key.
func NormalizeProjectKey(key string) (string, error) {
	key = strings.ToLower(strings.TrimSpace(key))
	if !projectKeyRe.MatchString(key) {
		return "", ErrInvalidKey
	}
	return key, nil
}

const projectSelect = `SELECT p.id, p.key, p.name, p.description, p.created_at, p.updated_at,
	(SELECT count(*) FROM jobs j WHERE j.project_id = p.id),
	(SELECT count(*) FROM jobs j WHERE j.project_id = p.id AND j.enabled AND j.last_status = 'failed')
	FROM projects p`

func scanProject(row interface{ Scan(...any) error }) (*Project, error) {
	p := &Project{}
	err := row.Scan(&p.ID, &p.Key, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt, &p.JobCount, &p.FailingJobs)
	if err != nil {
		return nil, notFound(err)
	}
	return p, nil
}

func (s *Store) ListProjects(ctx context.Context) ([]*Project, error) {
	rows, err := s.Pool.Query(ctx, projectSelect+` ORDER BY p.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) ProjectByKey(ctx context.Context, key string) (*Project, error) {
	return scanProject(s.Pool.QueryRow(ctx, projectSelect+` WHERE p.key = $1`, strings.ToLower(key)))
}

func (s *Store) CreateProject(ctx context.Context, key, name, description, createdBy string) (*Project, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO projects (key, name, description, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`, key, name, description, createdBy).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.ProjectByKey(ctx, key)
}

// UpdateProject changes name/description and optionally renames the key.
// After a rename the old key simply stops working (plan.md §1.1).
func (s *Store) UpdateProject(ctx context.Context, id, key, name, description string) (*Project, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE projects SET key = $2, name = $3, description = $4, updated_at = now()
		WHERE id = $1`, id, key, name, description)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.ProjectByKey(ctx, key)
}

func (s *Store) DeleteProject(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
