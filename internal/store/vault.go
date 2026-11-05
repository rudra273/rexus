package store

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

// ErrStale means a secret changed between loading it and saving an update.
var ErrStale = errors.New("secret was changed by someone else — reload and try again")

// ---- environments ----

type Environment struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	Name        string    `json:"name"`
	SecretCount int       `json:"secret_count"`
	CreatedAt   time.Time `json:"created_at"`
}

var envNameRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,29}$`)

var ErrInvalidEnvName = errors.New("environment name must be 1–30 characters: lowercase letters, numbers, dashes or underscores, starting with a letter")

func NormalizeEnvName(name string) (string, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !envNameRe.MatchString(name) {
		return "", ErrInvalidEnvName
	}
	return name, nil
}

const envSelect = `SELECT e.id, e.project_id, e.name, e.created_at,
	(SELECT count(*) FROM secrets s WHERE s.environment_id = e.id)
	FROM environments e`

func (s *Store) ListEnvironments(ctx context.Context, projectID string) ([]*Environment, error) {
	rows, err := s.Pool.Query(ctx, envSelect+` WHERE e.project_id = $1 ORDER BY e.position, e.name`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Environment{}
	for rows.Next() {
		e := &Environment{}
		if err := rows.Scan(&e.ID, &e.ProjectID, &e.Name, &e.CreatedAt, &e.SecretCount); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) EnvironmentByID(ctx context.Context, id string) (*Environment, error) {
	e := &Environment{}
	err := s.Pool.QueryRow(ctx, envSelect+` WHERE e.id = $1`, id).
		Scan(&e.ID, &e.ProjectID, &e.Name, &e.CreatedAt, &e.SecretCount)
	if err != nil {
		return nil, notFound(err)
	}
	return e, nil
}

func (s *Store) CreateEnvironment(ctx context.Context, projectID, name string) (*Environment, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO environments (project_id, name, position)
		VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM environments WHERE project_id = $1), 0))
		RETURNING id`, projectID, name).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.EnvironmentByID(ctx, id)
}

func (s *Store) RenameEnvironment(ctx context.Context, id, name string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE environments SET name = $2 WHERE id = $1`, id, name)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteEnvironment removes an environment. Its secrets go with it (the
// handler only allows deleting an empty one); jobs and checks scoped to it
// block the delete with ErrInUse.
func (s *Store) DeleteEnvironment(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM environments WHERE id = $1`, id)
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

// ---- secrets ----

type Secret struct {
	ID              string            `json:"id"`
	EnvironmentID   string            `json:"environment_id"`
	EnvironmentName string            `json:"environment"`
	ProjectID       string            `json:"project_id"`
	ProjectKey      string            `json:"project_key"`
	ProjectName     string            `json:"project_name"`
	ServiceID       *string           `json:"service_id"` // nil = belongs to the project directly
	ServiceKey      *string           `json:"service_key"`
	ServiceName     *string           `json:"service_name"`
	Name            string            `json:"name"`
	ExpiresOn       *string           `json:"expires_on"` // YYYY-MM-DD
	DaysLeft        *int              `json:"days_left"`  // negative = already expired
	Notes           string            `json:"notes"`
	Tags            []string          `json:"tags"`
	CustomFields    map[string]string `json:"custom_fields"`
	CurrentVersion  int               `json:"current_version"`
	CreatedAt       time.Time         `json:"created_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
	UpdatedBy       *string           `json:"updated_by"`
}

const secretSelect = `SELECT s.id, s.environment_id, e.name, s.project_id, p.key, p.name, s.service_id, sv.key, sv.name, s.name,
	to_char(s.expires_on, 'YYYY-MM-DD'), (s.expires_on - current_date), s.notes, s.tags, s.custom_fields,
	s.current_version, s.created_at, s.updated_at, u.email
	FROM secrets s
	JOIN environments e ON e.id = s.environment_id
	JOIN projects p ON p.id = s.project_id
	LEFT JOIN services sv ON sv.id = s.service_id
	LEFT JOIN users u ON u.id = s.updated_by`

func scanSecret(row interface{ Scan(...any) error }) (*Secret, error) {
	x := &Secret{}
	err := row.Scan(&x.ID, &x.EnvironmentID, &x.EnvironmentName, &x.ProjectID, &x.ProjectKey, &x.ProjectName,
		&x.ServiceID, &x.ServiceKey, &x.ServiceName, &x.Name,
		&x.ExpiresOn, &x.DaysLeft, &x.Notes, &x.Tags, &x.CustomFields, &x.CurrentVersion,
		&x.CreatedAt, &x.UpdatedAt, &x.UpdatedBy)
	if err != nil {
		return nil, notFound(err)
	}
	if x.Tags == nil {
		x.Tags = []string{}
	}
	if x.CustomFields == nil {
		x.CustomFields = map[string]string{}
	}
	return x, nil
}

// SecretFilter narrows ListSecrets. Zero values mean "no filter".
type SecretFilter struct {
	EnvironmentID string
	ProjectID     string
	Service       ScopeFilter // "" = all, "-" = project directly, or a service ID
	Query         string      // matches secret name, project key/name or service key
	Tag           string
	ExpiringDays  *int   // expires within N days (already-expired secrets included)
	Access        Access // which projects the caller may see
}

func (s *Store) ListSecrets(ctx context.Context, f SecretFilter) ([]*Secret, error) {
	var b filterBuilder
	if f.EnvironmentID != "" {
		b.add("s.environment_id = ?", f.EnvironmentID)
	}
	if f.ProjectID != "" {
		b.add("s.project_id = ?", f.ProjectID)
	}
	b.scope("s.service_id", f.Service)
	b.access("s.project_id", f.Access)
	if q := strings.TrimSpace(f.Query); q != "" {
		b.add("(s.name ILIKE '%' || ? || '%' OR p.key ILIKE '%' || ? || '%' OR p.name ILIKE '%' || ? || '%' OR sv.key ILIKE '%' || ? || '%')", q)
	}
	if f.Tag != "" {
		b.add("? = ANY (s.tags)", strings.ToLower(f.Tag))
	}
	if f.ExpiringDays != nil {
		b.add("s.expires_on IS NOT NULL AND s.expires_on <= current_date + (?)::int", *f.ExpiringDays)
	}
	q := secretSelect + b.sql() + ` ORDER BY p.name, e.position, sv.position NULLS FIRST, sv.name NULLS FIRST, s.name LIMIT 500`

	rows, err := s.Pool.Query(ctx, q, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Secret{}
	for rows.Next() {
		x, err := scanSecret(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) SecretByID(ctx context.Context, id string) (*Secret, error) {
	return scanSecret(s.Pool.QueryRow(ctx, secretSelect+` WHERE s.id = $1`, id))
}

// SecretByName finds one secret by project key, environment name and secret
// name, in exactly one scope: serviceKey "" means a secret of the project
// itself; otherwise a secret of that service. It never searches across scopes.
func (s *Store) SecretByName(ctx context.Context, projectKey, serviceKey, env, name string) (*Secret, error) {
	q := secretSelect + ` WHERE p.key = $1 AND e.name = $2 AND s.name = $3 AND s.service_id IS NULL`
	args := []any{strings.ToLower(projectKey), strings.ToLower(env), name}
	if serviceKey != "" {
		q = secretSelect + ` WHERE p.key = $1 AND e.name = $2 AND s.name = $3 AND sv.key = $4`
		args = append(args, strings.ToLower(serviceKey))
	}
	return scanSecret(s.Pool.QueryRow(ctx, q, args...))
}

// CreateSecret inserts a secret and its first version. sec.ID must be set
// (it is part of the encryption context), as must ProjectID and EnvironmentID.
func (s *Store) CreateSecret(ctx context.Context, sec *Secret, ciphertext, wrappedKey []byte, userID string) (*Secret, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `INSERT INTO secrets (id, project_id, environment_id, service_id, name, expires_on, notes,
			tags, custom_fields, current_version, created_by, updated_by)
		VALUES ($1, $2, $3, $4, $5, $6::text::date, $7, $8, $9, 1, $10, $10)`,
		sec.ID, sec.ProjectID, sec.EnvironmentID, sec.ServiceID, sec.Name, sec.ExpiresOn, sec.Notes, sec.Tags,
		sec.CustomFields, userID)
	if err != nil {
		return nil, writeErr(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO secret_versions (secret_id, version, ciphertext, wrapped_key, created_by)
		VALUES ($1, 1, $2, $3, $4)`, sec.ID, ciphertext, wrappedKey, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.SecretByID(ctx, sec.ID)
}

// NewVersion is a new encrypted value for an existing secret. PrevVersion is
// the version the caller saw: if someone else saved in between, the update
// fails with ErrStale instead of silently overwriting.
type NewVersion struct {
	PrevVersion int
	Ciphertext  []byte
	WrappedKey  []byte
}

// UpdateSecret saves metadata and, when nv is set, a new value version.
func (s *Store) UpdateSecret(ctx context.Context, sec *Secret, nv *NewVersion, userID string) (*Secret, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if nv != nil {
		tag, err := tx.Exec(ctx, `UPDATE secrets SET current_version = current_version + 1
			WHERE id = $1 AND current_version = $2`, sec.ID, nv.PrevVersion)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, ErrStale
		}
		if _, err := tx.Exec(ctx, `INSERT INTO secret_versions (secret_id, version, ciphertext, wrapped_key, created_by)
			VALUES ($1, $2, $3, $4, $5)`, sec.ID, nv.PrevVersion+1, nv.Ciphertext, nv.WrappedKey, userID); err != nil {
			return nil, err
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE secrets SET name = $2, expires_on = $3::text::date, notes = $4, tags = $5,
			custom_fields = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
		sec.ID, sec.Name, sec.ExpiresOn, sec.Notes, sec.Tags, sec.CustomFields, userID)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.SecretByID(ctx, sec.ID)
}

// MoveSecret moves a secret to another scope of the same project: serviceID
// nil = the project directly. The ID, versions and ciphertexts stay as they
// are (the encryption context is only ID + version). ErrConflict when the
// destination already has a secret with this name in the same environment;
// ErrInvalidScope when the service belongs to another project.
func (s *Store) MoveSecret(ctx context.Context, id string, serviceID *string, userID string) (*Secret, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE secrets SET service_id = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
		id, serviceID, userID)
	if err != nil {
		return nil, writeErr(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.SecretByID(ctx, id)
}

func (s *Store) DeleteSecret(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM secrets WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- versions ----

type SecretVersion struct {
	Version   int       `json:"version"`
	CreatedBy *string   `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	Current   bool      `json:"current"`
}

func (s *Store) ListVersions(ctx context.Context, secretID string) ([]*SecretVersion, error) {
	rows, err := s.Pool.Query(ctx, `SELECT v.version, u.email, v.created_at, v.version = s.current_version
		FROM secret_versions v
		JOIN secrets s ON s.id = v.secret_id
		LEFT JOIN users u ON u.id = v.created_by
		WHERE v.secret_id = $1 ORDER BY v.version DESC`, secretID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*SecretVersion{}
	for rows.Next() {
		v := &SecretVersion{}
		if err := rows.Scan(&v.Version, &v.CreatedBy, &v.CreatedAt, &v.Current); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// VersionData returns the encrypted value of one version.
func (s *Store) VersionData(ctx context.Context, secretID string, version int) (ciphertext, wrappedKey []byte, err error) {
	err = s.Pool.QueryRow(ctx, `SELECT ciphertext, wrapped_key FROM secret_versions
		WHERE secret_id = $1 AND version = $2`, secretID, version).Scan(&ciphertext, &wrappedKey)
	return ciphertext, wrappedKey, notFound(err)
}
