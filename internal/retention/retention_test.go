package retention_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"

	"rexus/internal/db"
	"rexus/internal/retention"
	"rexus/internal/store"
)

func TestValidate(t *testing.T) {
	if err := retention.Defaults().Validate(); err != nil {
		t.Fatalf("defaults must be valid: %v", err)
	}
	bad := []func(*retention.Policy){
		func(p *retention.Policy) { p.JobRunDays = 3 },
		func(p *retention.Policy) { p.HealthResultDays = 400 },
		func(p *retention.Policy) { p.AuditDays = 30 }, // 0 is fine, 30 is too short
		func(p *retention.Policy) { p.SecretVersionsKeep = 1 },
	}
	for i, f := range bad {
		p := retention.Defaults()
		f(&p)
		if p.Validate() == nil {
			t.Errorf("case %d: expected an error", i)
		}
	}
	p := retention.Defaults()
	p.AuditDays, p.SecretVersionsKeep = 0, 0 // forever / all
	if err := p.Validate(); err != nil {
		t.Errorf("0 = no limit should be valid: %v", err)
	}
}

// TestCleanup runs the real SQL against a scratch Postgres (REXUS_TEST_DATABASE_URL). It is skipped otherwise.
func TestCleanup(t *testing.T) {
	url := os.Getenv("REXUS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("REXUS_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	count := func(q string) (n int) {
		t.Helper()
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}

	exec(`INSERT INTO projects (id, key, name) VALUES ('00000000-0000-0000-0000-0000000000b1', 'proj', 'Proj')`)
	// A job with 30 old runs and a quiet job with 3 old runs; one old run is still "running".
	exec(`INSERT INTO jobs (id, project_id, name, schedule) VALUES
		('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'busy', '@every 1m'),
		('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', 'rare', '@monthly')`)
	exec(`INSERT INTO job_runs (job_id, trigger, status, started_at)
		SELECT '00000000-0000-0000-0000-0000000000a1', 'schedule', 'success', now() - (i || ' days')::interval FROM generate_series(40, 69) i`)
	exec(`INSERT INTO job_runs (job_id, trigger, status, started_at)
		SELECT '00000000-0000-0000-0000-0000000000a2', 'schedule', 'success', now() - (i || ' days')::interval FROM generate_series(100, 102) i`)
	exec(`INSERT INTO job_runs (job_id, trigger, status, started_at) VALUES ('00000000-0000-0000-0000-0000000000a1', 'schedule', 'running', now() - interval '200 days')`)

	// A secret at version 15 with all 15 versions stored.
	exec(`INSERT INTO environments (id, project_id, name) VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'dev')`)
	exec(`INSERT INTO secrets (id, project_id, environment_id, name, current_version) VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'K', 15)`)
	exec(`INSERT INTO secret_versions (secret_id, version, ciphertext, wrapped_key)
		SELECT '00000000-0000-0000-0000-0000000000d1', i, '\x00', '\x00' FROM generate_series(1, 15) i`)

	// Audit, health events, alerts: one old, one recent each; plus an old reminder and an old plain alert.
	exec(`INSERT INTO audit_log (at, actor, action) VALUES (now() - interval '400 days', 'x', 'old'), (now(), 'x', 'new')`)
	exec(`INSERT INTO alerts_sent (at, event, channel_name, title, status, dedupe_key) VALUES
		(now() - interval '120 days', 'check.down', 'c', 'plain old', 'sent', NULL),
		(now() - interval '120 days', 'secret.expiring', 'c', 'reminder', 'sent', 'secret:1:2027-01-01:30'),
		(now(), 'check.down', 'c', 'new', 'sent', NULL)`)
	exec(`INSERT INTO invites (email, role, token_hash, expires_at, used_at) VALUES
		('a@x.io', 'viewer', '\x01', now() - interval '60 days', NULL),
		('b@x.io', 'viewer', '\x02', now() + interval '2 days', NULL)`)

	svc := retention.New(store.New(pool), log)

	// Before the owner confirms: only the previously-existing cleanups run.
	res, err := svc.Run(ctx, "schedule", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := count(`SELECT count(*) FROM secret_versions`); got != 15 {
		t.Errorf("unconfirmed policy must not touch secret versions, have %d", got)
	}
	if got := count(`SELECT count(*) FROM audit_log WHERE action = 'old'`); got != 1 {
		t.Errorf("unconfirmed policy must not touch the audit log")
	}
	if res.Deleted["job_runs"] == 0 {
		t.Errorf("job runs should have been cleaned: %v", res.Deleted)
	}
	// busy keeps its newest 20 (30 - 10 pruned), rare keeps all 3, the running one stays.
	if got := count(`SELECT count(*) FROM job_runs WHERE job_id = '00000000-0000-0000-0000-0000000000a1' AND status = 'success'`); got != 20 {
		t.Errorf("busy job should keep 20 runs, has %d", got)
	}
	if got := count(`SELECT count(*) FROM job_runs WHERE job_id = '00000000-0000-0000-0000-0000000000a2'`); got != 3 {
		t.Errorf("rare job must keep its runs, has %d", got)
	}
	if got := count(`SELECT count(*) FROM job_runs WHERE status = 'running'`); got != 1 {
		t.Errorf("a running run must never be deleted")
	}
	if got := count(`SELECT count(*) FROM alerts_sent`); got != 2 {
		t.Errorf("old plain alert should go, reminder and new stay: %d left", got)
	}
	if got := count(`SELECT count(*) FROM invites`); got != 1 {
		t.Errorf("only the long-expired invite should go: %d left", got)
	}

	// The run is logged, and the weekly schedule moved a week ahead.
	runs, err := svc.Runs(ctx, 10)
	if err != nil || len(runs) != 1 || runs[0].Status != "success" || runs[0].Trigger != "schedule" {
		t.Errorf("want one successful scheduled run in the log, got %v (%v)", runs, err)
	}
	if job, err := svc.Job(ctx); err != nil || job.NextRunAt == nil || !job.Enabled || job.LastRun == nil {
		t.Errorf("job view: %+v %v", job, err)
	}

	// Preview counts without deleting.
	p := retention.Defaults()
	p.Confirmed = true
	counts, err := svc.Count(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range counts {
		if c.Key == "secret_versions" && c.Eligible != 5 {
			t.Errorf("preview: want 5 old versions, got %d", c.Eligible)
		}
	}
	if got := count(`SELECT count(*) FROM secret_versions`); got != 15 {
		t.Fatalf("preview deleted rows")
	}

	// After confirming: newest 10 versions stay, the current one included; old audit entry goes.
	if _, err := svc.Save(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Run(ctx, "manual", nil); err != nil {
		t.Fatal(err)
	}
	if got := count(`SELECT count(*) FROM secret_versions`); got != 10 {
		t.Errorf("want 10 versions left, have %d", got)
	}
	if got := count(`SELECT min(version) FROM secret_versions`); got != 6 {
		t.Errorf("want versions 6..15 left, oldest is %d", got)
	}
	if got := count(`SELECT count(*) FROM secret_versions WHERE version = 15`); got != 1 {
		t.Errorf("current version must stay")
	}
	if got := count(`SELECT count(*) FROM audit_log WHERE action = 'old'`); got != 0 {
		t.Errorf("old audit entry should be gone")
	}
	if got := count(`SELECT count(*) FROM audit_log WHERE action = 'new'`); got != 1 {
		t.Errorf("new audit entry must stay")
	}
	if runs, _ := svc.Runs(ctx, 10); len(runs) != 2 {
		t.Errorf("want 2 runs in the log, got %d", len(runs))
	}
	if err := svc.SetEnabled(ctx, false); err != nil {
		t.Fatal(err)
	}
	if job, _ := svc.Job(ctx); job.Enabled || job.NextRunAt != nil {
		t.Errorf("a stopped job has no next run: %+v", job)
	}
	if got := count(`SELECT count(*) FROM secrets`); got != 1 {
		t.Errorf("secrets themselves must never be deleted")
	}
}
