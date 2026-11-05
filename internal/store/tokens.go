package store

import (
	"context"
	"time"
)

// Token kinds. An "api" token is for an external tool (a CRM, a status board…)
// and sees the whole API. A "deploy" token is scoped to one project +
// environment (+ optional service) and can only fetch that scope's env.
const (
	TokenKindAPI    = "api"
	TokenKindDeploy = "deploy"
)

// APIToken is a credential for an external tool. The token itself is never
// stored — only its hash — so it can be shown exactly once, when created.
type APIToken struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"` // api | deploy
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Role       string     `json:"role"`       // contributor | viewer (deploy tokens: contributor)
	CreatedBy  *string    `json:"created_by"` // email of whoever created it
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	LastUsedIP *string    `json:"last_used_ip"`
	RevokedAt  *time.Time `json:"revoked_at"`
	Status     string     `json:"status"` // active | expired | revoked

	// Scope — deploy tokens only.
	ProjectID       *string `json:"-"`
	ServiceID       *string `json:"-"`
	EnvironmentID   *string `json:"-"`
	ProjectKey      *string `json:"project"`
	ProjectName     *string `json:"project_name"`
	ServiceKey      *string `json:"service"` // nil = the project's own secrets
	EnvironmentName *string `json:"environment"`
}

const tokenSelect = `SELECT t.id, t.kind, t.name, t.prefix, t.role, u.email, t.created_at, t.expires_at, t.last_used_at, t.last_used_ip, t.revoked_at,
	CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked'
	     WHEN t.expires_at IS NOT NULL AND t.expires_at <= now() THEN 'expired'
	     ELSE 'active' END,
	t.project_id, t.service_id, t.environment_id, p.key, p.name, sv.key, en.name
	FROM api_tokens t
	LEFT JOIN users u ON u.id = t.created_by
	LEFT JOIN projects p ON p.id = t.project_id
	LEFT JOIN services sv ON sv.id = t.service_id
	LEFT JOIN environments en ON en.id = t.environment_id`

func scanToken(row interface{ Scan(...any) error }) (*APIToken, error) {
	t := &APIToken{}
	if err := row.Scan(&t.ID, &t.Kind, &t.Name, &t.Prefix, &t.Role, &t.CreatedBy, &t.CreatedAt, &t.ExpiresAt, &t.LastUsedAt,
		&t.LastUsedIP, &t.RevokedAt, &t.Status,
		&t.ProjectID, &t.ServiceID, &t.EnvironmentID, &t.ProjectKey, &t.ProjectName, &t.ServiceKey, &t.EnvironmentName); err != nil {
		return nil, notFound(err)
	}
	return t, nil
}

func (s *Store) CreateToken(ctx context.Context, name, prefix, role string, tokenHash []byte, createdBy string, expires *time.Time) (*APIToken, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO api_tokens (name, prefix, role, token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, name, prefix, role, tokenHash, createdBy, expires).Scan(&id)
	if err != nil {
		return nil, err
	}
	return scanToken(s.Pool.QueryRow(ctx, tokenSelect+` WHERE t.id = $1`, id))
}

// CreateDeployToken makes a token scoped to one project and environment, and
// optionally one service (serviceID nil = the project's own secrets).
func (s *Store) CreateDeployToken(ctx context.Context, name, prefix string, tokenHash []byte, createdBy, projectID string, serviceID *string, environmentID string, expires *time.Time) (*APIToken, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO api_tokens (kind, name, prefix, role, token_hash, created_by, expires_at, project_id, service_id, environment_id)
		VALUES ('deploy', $1, $2, 'contributor', $3, $4, $5, $6, $7, $8) RETURNING id`,
		name, prefix, tokenHash, createdBy, expires, projectID, serviceID, environmentID).Scan(&id)
	if err != nil {
		return nil, writeErr(err)
	}
	return scanToken(s.Pool.QueryRow(ctx, tokenSelect+` WHERE t.id = $1`, id))
}

// ListTokens lists tokens of one kind, newest first. projectID "" = all projects.
func (s *Store) ListTokens(ctx context.Context, kind, projectID string) ([]*APIToken, error) {
	q, args := tokenSelect+` WHERE t.kind = $1`, []any{kind}
	if projectID != "" {
		q += ` AND t.project_id = $2`
		args = append(args, projectID)
	}
	rows, err := s.Pool.Query(ctx, q+` ORDER BY t.created_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*APIToken{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TokenByID returns a token of any status.
func (s *Store) TokenByID(ctx context.Context, id string) (*APIToken, error) {
	return scanToken(s.Pool.QueryRow(ctx, tokenSelect+` WHERE t.id = $1`, id))
}

// TokenByHash returns the token only if it is usable: not revoked, not expired.
func (s *Store) TokenByHash(ctx context.Context, hash []byte) (*APIToken, error) {
	t, err := scanToken(s.Pool.QueryRow(ctx, tokenSelect+` WHERE t.token_hash = $1`, hash))
	if err != nil {
		return nil, err
	}
	if t.Status != "active" {
		return nil, ErrNotFound
	}
	return t, nil
}

func (s *Store) CountActiveTokens(ctx context.Context, kind string) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM api_tokens
		WHERE kind = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, kind).Scan(&n)
	return n, err
}

// RevokeToken stops a token working at once. Already-revoked tokens are "not found".
func (s *Store) RevokeToken(ctx context.Context, id string) (*APIToken, error) {
	var found string
	err := s.Pool.QueryRow(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, id).Scan(&found)
	if err != nil {
		return nil, notFound(err)
	}
	return scanToken(s.Pool.QueryRow(ctx, tokenSelect+` WHERE t.id = $1`, found))
}

// TouchToken records use. It writes at most once a minute per token, so a tool
// that polls every second doesn't turn into a database write per request.
func (s *Store) TouchToken(ctx context.Context, id, ip string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = now(), last_used_ip = $2
		WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, id, ip)
	return err
}
