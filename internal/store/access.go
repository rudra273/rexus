package store

import (
	"context"
	"strings"
)

// Access is "whose eyes" a query is for. The zero value sees every project.
//
//	Viewer: a user ID — only the projects that user may see (see visibleProjects).
//	        "" means unrestricted: the owner, or Rexus itself (scheduler, alerts).
//	Only:   non-nil — additionally limited to these project IDs (API tokens).
type Access struct {
	Viewer string
	Only   []string
}

// NoOne is a user ID that exists nowhere: an Access with this viewer sees nothing.
const NoOne = "00000000-0000-0000-0000-000000000000"

// visibleProjects is the one rule for who sees which project, as a SQL condition on a
// project ID column. It takes the viewer's user ID as its only argument (used twice).
//
//   - an explicit grant (project_access) always counts, even for an owner-only project;
//   - an admin sees every project that is not owner-only if they have "all projects",
//     and otherwise only the ones they created (also never owner-only ones).
//
// The owner is never filtered — callers skip the condition for them.
const visibleProjects = ` IN (SELECT pv.id FROM projects pv WHERE
	EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = pv.id AND pa.user_id = ?)
	OR (NOT pv.owner_only AND EXISTS (SELECT 1 FROM users vu WHERE vu.id = ? AND vu.role = 'admin'
		AND (vu.all_projects OR pv.created_by = vu.id))))`

// access adds the conditions that keep column col (a project ID) within a.
func (b *filterBuilder) access(col string, a Access) {
	if a.Viewer != "" {
		b.add(col+visibleProjects, a.Viewer)
	}
	if a.Only != nil {
		b.add(col+" = ANY(?::uuid[])", a.Only)
	}
}

// CanSee reports whether a may see the project.
func (s *Store) CanSee(ctx context.Context, a Access, projectID string) (bool, error) {
	if !IsUUID(projectID) {
		return false, nil
	}
	var b filterBuilder
	b.add("p.id = ?", projectID)
	b.access("p.id", a)
	var ok bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM projects p`+b.sql()+`)`, b.args...).Scan(&ok)
	return ok, err
}

func (s *Store) ProjectByKeyFor(ctx context.Context, a Access, key string) (*Project, error) {
	var b filterBuilder
	b.add("p.key = ?", strings.ToLower(key))
	b.access("p.id", a)
	return scanProject(s.Pool.QueryRow(ctx, projectSelect+b.sql(), b.args...))
}

func (s *Store) ListProjectsFor(ctx context.Context, a Access) ([]*Project, error) {
	var b filterBuilder
	b.access("p.id", a)
	rows, err := s.Pool.Query(ctx, projectSelect+b.sql()+` ORDER BY p.name`, b.args...)
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

// VisibleProjectIDs lists the IDs of every project a may see.
func (s *Store) VisibleProjectIDs(ctx context.Context, a Access) ([]string, error) {
	var b filterBuilder
	b.access("p.id", a)
	rows, err := s.Pool.Query(ctx, `SELECT p.id FROM projects p`+b.sql(), b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ProjectIDsByKeys maps project keys to IDs; ok is false if any key is unknown.
func (s *Store) ProjectIDsByKeys(ctx context.Context, keys []string) (ids []string, ok bool, err error) {
	ids = []string{}
	seen := map[string]bool{}
	for _, k := range keys {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		var id string
		if err := s.Pool.QueryRow(ctx, `SELECT id FROM projects WHERE key = $1`, k).Scan(&id); err != nil {
			if notFound(err) == ErrNotFound {
				return nil, false, nil
			}
			return nil, false, err
		}
		ids = append(ids, id)
	}
	return ids, true, nil
}

// ---- grants (project_access) ----

// GrantsByUser maps user ID → the keys of the projects shared with them that a can see.
func (s *Store) GrantsByUser(ctx context.Context, a Access) (map[string][]string, error) {
	var b filterBuilder
	b.access("p.id", a)
	rows, err := s.Pool.Query(ctx, `SELECT pa.user_id, p.key FROM project_access pa JOIN projects p ON p.id = pa.project_id`+
		b.sql()+` ORDER BY p.key`, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var uid, key string
		if err := rows.Scan(&uid, &key); err != nil {
			return nil, err
		}
		out[uid] = append(out[uid], key)
	}
	return out, rows.Err()
}

// SetUserGrants makes the user's grants, within the projects in scope, exactly
// projectIDs. Grants to projects outside scope are left alone — that is how an
// admin editing a user keeps the grants to projects the admin can't see.
func (s *Store) SetUserGrants(ctx context.Context, userID string, projectIDs, scope []string, grantedBy string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM project_access WHERE user_id = $1 AND project_id = ANY($2::uuid[])
		AND NOT (project_id = ANY($3::uuid[]))`, userID, scope, projectIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO project_access (user_id, project_id, granted_by)
		SELECT $1::uuid, p, $4::uuid FROM unnest($2::uuid[]) p WHERE p = ANY($3::uuid[])
		ON CONFLICT (user_id, project_id) DO NOTHING`, userID, projectIDs, scope, nullIfEmpty(grantedBy)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) SetAllProjects(ctx context.Context, userID string, v bool) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET all_projects = $2 WHERE id = $1`, userID, v)
	return err
}

// ProjectPerson is someone who can see a project, and why.
type ProjectPerson struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	Via   string `json:"via"` // owner | all_projects | creator | shared
}

// ProjectPeople lists every active user who can see the project, with the reason.
func (s *Store) ProjectPeople(ctx context.Context, projectID string) ([]*ProjectPerson, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT u.id, u.email, u.name, u.role,
		  CASE WHEN u.role = 'owner' THEN 'owner'
		       WHEN pa.user_id IS NOT NULL THEN 'shared'
		       WHEN u.all_projects THEN 'all_projects'
		       ELSE 'creator' END
		FROM users u
		JOIN projects p ON p.id = $1
		LEFT JOIN project_access pa ON pa.project_id = p.id AND pa.user_id = u.id
		WHERE u.status = 'active' AND (
		      u.role = 'owner'
		   OR pa.user_id IS NOT NULL
		   OR (u.role = 'admin' AND NOT p.owner_only AND (u.all_projects OR p.created_by = u.id)))
		ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, lower(u.email)`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*ProjectPerson{}
	for rows.Next() {
		p := &ProjectPerson{}
		if err := rows.Scan(&p.ID, &p.Email, &p.Name, &p.Role, &p.Via); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetProjectGrants makes the project's explicit grants, among the given users
// (the ones the actor may manage), exactly userIDs.
func (s *Store) SetProjectGrants(ctx context.Context, projectID string, userIDs, manageable []string, grantedBy string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM project_access WHERE project_id = $1 AND user_id = ANY($2::uuid[])
		AND NOT (user_id = ANY($3::uuid[]))`, projectID, manageable, userIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO project_access (user_id, project_id, granted_by)
		SELECT u, $1::uuid, $4::uuid FROM unnest($2::uuid[]) u WHERE u = ANY($3::uuid[])
		ON CONFLICT (user_id, project_id) DO NOTHING`, projectID, userIDs, manageable, nullIfEmpty(grantedBy)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) SetProjectOwnerOnly(ctx context.Context, projectID string, v bool) error {
	_, err := s.Pool.Exec(ctx, `UPDATE projects SET owner_only = $2, updated_at = now() WHERE id = $1`, projectID, v)
	return err
}

// UserGrantIDs lists every project explicitly shared with the user.
func (s *Store) UserGrantIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT project_id FROM project_access WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ProjectKeysByIDs maps project IDs to their keys.
func (s *Store) ProjectKeysByIDs(ctx context.Context, ids []string) (map[string]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, key FROM projects WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, key string
		if err := rows.Scan(&id, &key); err != nil {
			return nil, err
		}
		out[id] = key
	}
	return out, rows.Err()
}
