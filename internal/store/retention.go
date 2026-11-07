package store

import (
	"context"
	"fmt"
	"regexp"
	"time"
)

// PruneSpec describes rows that may be deleted from one table. Where is a SQL condition over the table
// aliased as t, with positional arguments in Args. It is built by the retention package from fixed text, never
// from user input.
type PruneSpec struct {
	Table string
	Where string
	Args  []any
}

var identRe = regexp.MustCompile(`^[a-z_]+$`)

const pruneBatch = 5000

// CountRows counts the rows a spec would delete.
func (s *Store) CountRows(ctx context.Context, p PruneSpec) (int64, error) {
	if !identRe.MatchString(p.Table) {
		return 0, fmt.Errorf("bad table %q", p.Table)
	}
	var n int64
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM `+p.Table+` t WHERE `+p.Where, p.Args...).Scan(&n)
	return n, err
}

// PruneRows deletes the rows a spec matches, in batches so a big first cleanup never holds a long lock or
// floods the write-ahead log. It returns how many rows went; on error, the batches done so far stay done.
func (s *Store) PruneRows(ctx context.Context, p PruneSpec) (int64, error) {
	if !identRe.MatchString(p.Table) {
		return 0, fmt.Errorf("bad table %q", p.Table)
	}
	q := `DELETE FROM ` + p.Table + ` WHERE ctid IN (SELECT t.ctid FROM ` + p.Table + ` t WHERE ` + p.Where +
		fmt.Sprintf(` LIMIT %d)`, pruneBatch)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tag, err := s.Pool.Exec(ctx, q, p.Args...)
		if err != nil {
			return total, err
		}
		n := tag.RowsAffected()
		total += n
		if n < pruneBatch {
			return total, nil
		}
	}
}

// TableUsage is the disk size and (estimated) row count of one table.
type TableUsage struct {
	Table string `json:"table"`
	Bytes int64  `json:"bytes"`
	Rows  int64  `json:"rows"`
}

// StorageUsage reports the size of the whole database and of the given tables (indexes included).
func (s *Store) StorageUsage(ctx context.Context, tables []string) (total int64, usage []TableUsage, err error) {
	if err = s.Pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&total); err != nil {
		return 0, nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT c.relname, pg_total_relation_size(c.oid), COALESCE(st.n_live_tup, 0)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
		LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
		WHERE c.relkind = 'r' AND c.relname = ANY($1)
		ORDER BY 2 DESC`, tables)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	usage = []TableUsage{}
	for rows.Next() {
		var u TableUsage
		if err := rows.Scan(&u.Table, &u.Bytes, &u.Rows); err != nil {
			return 0, nil, err
		}
		usage = append(usage, u)
	}
	return total, usage, rows.Err()
}

// SystemRun is one run of a built-in job (not tied to any project).
type SystemRun struct {
	ID          int64          `json:"id"`
	Job         string         `json:"job"`
	Trigger     string         `json:"trigger"` // schedule | manual
	Status      string         `json:"status"`  // running | success | failed
	TriggeredBy *string        `json:"triggered_by"`
	StartedAt   time.Time      `json:"started_at"`
	FinishedAt  *time.Time     `json:"finished_at"`
	DurationMS  *int           `json:"duration_ms"`
	Result      map[string]any `json:"result"`
	Error       *string        `json:"error"`
}

func (s *Store) StartSystemRun(ctx context.Context, job, trigger string, userID *string) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO system_job_runs (job, trigger, status, triggered_by)
		VALUES ($1, $2, 'running', $3) RETURNING id`, job, trigger, userID).Scan(&id)
	return id, err
}

func (s *Store) FinishSystemRun(ctx context.Context, id int64, status string, durationMS int, result map[string]any, errMsg *string) error {
	if result == nil {
		result = map[string]any{}
	}
	_, err := s.Pool.Exec(ctx, `UPDATE system_job_runs SET status = $2, duration_ms = $3, result = $4, error = $5,
		finished_at = now() WHERE id = $1`, id, status, durationMS, result, errMsg)
	return err
}

func (s *Store) ListSystemRuns(ctx context.Context, job string, limit int) ([]*SystemRun, error) {
	rows, err := s.Pool.Query(ctx, `SELECT r.id, r.job, r.trigger, r.status, u.email, r.started_at, r.finished_at,
			r.duration_ms, r.result, r.error
		FROM system_job_runs r LEFT JOIN users u ON u.id = r.triggered_by
		WHERE r.job = $1 ORDER BY r.started_at DESC, r.id DESC LIMIT $2`, job, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*SystemRun{}
	for rows.Next() {
		r := &SystemRun{}
		if err := rows.Scan(&r.ID, &r.Job, &r.Trigger, &r.Status, &r.TriggeredBy, &r.StartedAt, &r.FinishedAt,
			&r.DurationMS, &r.Result, &r.Error); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FailStaleSystemRuns marks runs left "running" by a restart as failed.
func (s *Store) FailStaleSystemRuns(ctx context.Context) error {
	_, err := s.Pool.Exec(ctx, `UPDATE system_job_runs SET status = 'failed', finished_at = now(),
		error = 'interrupted: Rexus restarted while this run was in progress' WHERE status = 'running'`)
	return err
}

// PruneSystemRuns keeps only the newest `keep` runs of a job.
func (s *Store) PruneSystemRuns(ctx context.Context, job string, keep int) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM system_job_runs WHERE job = $1 AND id NOT IN (
		SELECT id FROM system_job_runs WHERE job = $1 ORDER BY started_at DESC, id DESC LIMIT $2)`, job, keep)
	return err
}
