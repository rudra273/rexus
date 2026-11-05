package store

import (
	"context"
	"time"
)

// HTTPConfig is the config for an "http" job (ping / keepalive / webhook).
// Request headers are stored separately, encrypted (Job.HeadersEnc).
type HTTPConfig struct {
	URL            string `json:"url"`
	Method         string `json:"method"`
	Body           string `json:"body,omitempty"`
	ExpectedStatus string `json:"expected_status"` // e.g. "200-299" or "200,204"
}

type Job struct {
	ID             string     `json:"id"`
	ProjectID      *string    `json:"project_id"`
	ProjectKey     *string    `json:"project_key"`
	ProjectName    *string    `json:"project_name"`
	Name           string     `json:"name"`
	Type           string     `json:"type"`
	Schedule       string     `json:"schedule"`
	Config         HTTPConfig `json:"config"`
	TimeoutSeconds int        `json:"timeout_seconds"`
	Retries        int        `json:"retries"`
	Enabled        bool       `json:"enabled"`
	NextRunAt      *time.Time `json:"next_run_at"`
	LastRunAt      *time.Time `json:"last_run_at"`
	LastStatus     *string    `json:"last_status"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	HeadersEnc     []byte     `json:"-"`
}

type JobRun struct {
	ID              string     `json:"id"`
	JobID           string     `json:"job_id"`
	Trigger         string     `json:"trigger"`
	Status          string     `json:"status"`
	Attempts        int        `json:"attempts"`
	StatusCode      *int       `json:"status_code"`
	DurationMS      *int       `json:"duration_ms"`
	Error           *string    `json:"error"`
	ResponseSnippet *string    `json:"response_snippet"`
	StartedAt       time.Time  `json:"started_at"`
	FinishedAt      *time.Time `json:"finished_at"`
}

const jobSelect = `SELECT j.id, j.project_id, p.key, p.name, j.name, j.type, j.schedule, j.config, j.headers_enc,
	j.timeout_seconds, j.retries, j.enabled, j.next_run_at, j.last_run_at, j.last_status, j.created_at, j.updated_at
	FROM jobs j LEFT JOIN projects p ON p.id = j.project_id`

func scanJob(row interface{ Scan(...any) error }) (*Job, error) {
	j := &Job{}
	err := row.Scan(&j.ID, &j.ProjectID, &j.ProjectKey, &j.ProjectName, &j.Name, &j.Type, &j.Schedule, &j.Config,
		&j.HeadersEnc, &j.TimeoutSeconds, &j.Retries, &j.Enabled, &j.NextRunAt, &j.LastRunAt, &j.LastStatus,
		&j.CreatedAt, &j.UpdatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return j, nil
}

// ListJobs lists all jobs, or only a project's jobs when projectID is set.
func (s *Store) ListJobs(ctx context.Context, projectID *string) ([]*Job, error) {
	q := jobSelect + ` ORDER BY p.name NULLS FIRST, j.name`
	args := []any{}
	if projectID != nil {
		q = jobSelect + ` WHERE j.project_id = $1 ORDER BY j.name`
		args = append(args, *projectID)
	}
	rows, err := s.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Store) JobByID(ctx context.Context, id string) (*Job, error) {
	return scanJob(s.Pool.QueryRow(ctx, jobSelect+` WHERE j.id = $1`, id))
}

func (s *Store) CreateJob(ctx context.Context, j *Job, createdBy string) (*Job, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO jobs (project_id, name, type, schedule, config, headers_enc,
			timeout_seconds, retries, enabled, next_run_at, created_by)
		VALUES ($1, $2, 'http', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
		j.ProjectID, j.Name, j.Schedule, j.Config, j.HeadersEnc, j.TimeoutSeconds, j.Retries, j.Enabled,
		j.NextRunAt, createdBy).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.JobByID(ctx, id)
}

func (s *Store) UpdateJob(ctx context.Context, j *Job) (*Job, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE jobs SET project_id = $2, name = $3, schedule = $4, config = $5,
			headers_enc = $6, timeout_seconds = $7, retries = $8, enabled = $9, next_run_at = $10, updated_at = now()
		WHERE id = $1`,
		j.ID, j.ProjectID, j.Name, j.Schedule, j.Config, j.HeadersEnc, j.TimeoutSeconds, j.Retries, j.Enabled, j.NextRunAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.JobByID(ctx, j.ID)
}

func (s *Store) DeleteJob(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM jobs WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClaimDueJobs atomically picks enabled jobs whose next_run_at has passed and
// moves next_run_at forward using next(). SKIP LOCKED means two Rexus
// processes can never claim the same run.
//
// Catch-up policy: next is computed from *now*, so if the host was asleep and
// several runs were missed, the job runs once and then continues on schedule.
func (s *Store) ClaimDueJobs(ctx context.Context, limit int, next func(schedule string) (*time.Time, error)) ([]*Job, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, jobSelect+` WHERE j.enabled AND j.next_run_at <= now()
		ORDER BY j.next_run_at LIMIT $1 FOR UPDATE OF j SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	var jobs []*Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, j := range jobs {
		n, err := next(j.Schedule)
		if err != nil {
			// Unparseable schedule (shouldn't happen — validated on save): disable it.
			if _, err := tx.Exec(ctx, `UPDATE jobs SET enabled = false, next_run_at = NULL WHERE id = $1`, j.ID); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE jobs SET next_run_at = $2 WHERE id = $1`, j.ID, n); err != nil {
			return nil, err
		}
	}
	return jobs, tx.Commit(ctx)
}

func (s *Store) CreateRun(ctx context.Context, jobID, trigger string) (string, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `INSERT INTO job_runs (job_id, trigger, status) VALUES ($1, $2, 'running') RETURNING id`,
		jobID, trigger).Scan(&id)
	return id, err
}

func (s *Store) FinishRun(ctx context.Context, r *JobRun) error {
	_, err := s.Pool.Exec(ctx, `UPDATE job_runs SET status = $2, attempts = $3, status_code = $4, duration_ms = $5,
		error = $6, response_snippet = $7, finished_at = now() WHERE id = $1`,
		r.ID, r.Status, r.Attempts, r.StatusCode, r.DurationMS, r.Error, r.ResponseSnippet)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `UPDATE jobs SET last_run_at = now(), last_status = $2 WHERE id = $1`, r.JobID, r.Status)
	return err
}

func (s *Store) ListRuns(ctx context.Context, jobID string, limit int) ([]*JobRun, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, job_id, trigger, status, attempts, status_code, duration_ms, error,
			response_snippet, started_at, finished_at
		FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2`, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*JobRun{}
	for rows.Next() {
		r := &JobRun{}
		if err := rows.Scan(&r.ID, &r.JobID, &r.Trigger, &r.Status, &r.Attempts, &r.StatusCode, &r.DurationMS,
			&r.Error, &r.ResponseSnippet, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FailStaleRuns marks runs left "running" by a crash/restart as failed.
func (s *Store) FailStaleRuns(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE job_runs SET status = 'failed', error = 'interrupted: Rexus restarted while this run was in progress',
		finished_at = now() WHERE status = 'running'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// PruneRuns deletes run history older than the given age.
func (s *Store) PruneRuns(ctx context.Context, olderThan time.Duration) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM job_runs WHERE started_at < $1`, time.Now().Add(-olderThan))
	return err
}
