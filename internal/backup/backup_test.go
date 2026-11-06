package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rexus/internal/store"
)

const testURL = "postgres://rexus:p%40ss%2Fw0rd@db.example:5433/rexusdb?sslmode=require"

// script writes a tiny fake command-line tool and returns its path.
func script(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

const (
	dumpOK    = `printf 'PGDMP fake data'`
	listUsers = `echo '; 200; 1259 16400 TABLE public users rexus'`
	listOther = `echo '; 200; 1259 16400 TABLE public something_else rexus'`
	dumpFails = `echo 'pg_dump: error: connection to server failed: password authentication failed' >&2; exit 1`
	dumpEmpty = `exit 0`
	dumpV     = `echo 'pg_dump: error: aborting because of server version mismatch' >&2; exit 1`
)

func newSvc(t *testing.T) *Service {
	t.Helper()
	return &Service{dir: filepath.Join(t.TempDir(), "backups"), dbURL: testURL, pgDump: script(t, dumpOK), pgRestore: script(t, listUsers)}
}

func ctx() context.Context { return context.Background() }

func names(files []File) []string {
	var out []string
	for _, f := range files {
		out = append(out, f.Name)
	}
	return out
}

// ---- writing a backup ----

func TestDumpWritesAtomicallyWithPrivatePermissions(t *testing.T) {
	s := newSvc(t)
	size, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err != nil {
		t.Fatal(err)
	}
	final := filepath.Join(s.dir, "rexus-20261105-120000.dump")
	info, err := os.Stat(final)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != size || size != int64(len("PGDMP fake data")) {
		t.Errorf("size mismatch: file %d, reported %d", info.Size(), size)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("backup must be private (0600), got %v", info.Mode().Perm())
	}
	if _, err := os.Stat(final + ".partial"); !os.IsNotExist(err) {
		t.Error("the .partial file must be gone after a successful backup")
	}
	if dir, _ := os.Stat(s.dir); dir.Mode().Perm() != 0o700 {
		t.Errorf("a newly created backup folder should be 0700, got %v", dir.Mode().Perm())
	}
}

func TestFailedDumpLeavesNothingBehind(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpFails)
	_, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err == nil || !strings.Contains(err.Error(), "password authentication failed") {
		t.Fatalf("the reason from pg_dump should surface: %v", err)
	}
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 0 {
		t.Fatalf("a failed backup must leave no file, found %v", entries)
	}
}

func TestEmptyDumpIsAFailure(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpEmpty)
	if _, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump"); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("got %v", err)
	}
	if files, _ := s.Files(); len(files) != 0 {
		t.Fatal("no file should remain")
	}
}

func TestMissingPgDumpExplainsWhatToDo(t *testing.T) {
	s := newSvc(t)
	s.pgDump = "/definitely/not/installed/pg_dump"
	_, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err == nil || !strings.Contains(err.Error(), "isn't installed") {
		t.Fatalf("got %v", err)
	}
}

func TestVersionMismatchGetsAHint(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpV)
	_, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err == nil || !strings.Contains(err.Error(), "same version") {
		t.Fatalf("got %v", err)
	}
}

func TestBackupThatFailsVerificationIsDiscarded(t *testing.T) {
	s := newSvc(t)
	s.pgRestore = script(t, listOther) // readable archive, but not Rexus data
	_, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Fatalf("got %v", err)
	}
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 0 {
		t.Fatalf("an unverified backup must not be kept: %v", entries)
	}
}

func TestUnusableFolderGivesAClearError(t *testing.T) {
	s := newSvc(t)
	blocker := filepath.Join(t.TempDir(), "iam-a-file")
	os.WriteFile(blocker, []byte("x"), 0o600)
	s.dir = filepath.Join(blocker, "backups") // can't create a folder inside a file
	_, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump")
	if err == nil || !strings.Contains(err.Error(), "backup folder") {
		t.Fatalf("got %v", err)
	}
	if msg := s.CheckDir(); !strings.Contains(msg, "can't") {
		t.Fatalf("CheckDir should describe the problem, got %q", msg)
	}
	s.dir = ""
	if _, err := s.dumpToFile(ctx(), "x"); err == nil || !strings.Contains(err.Error(), "REXUS_BACKUP_DIR") {
		t.Fatalf("an unset folder should name the setting: %v", err)
	}
}

func TestCheckDirOK(t *testing.T) {
	s := newSvc(t)
	if msg := s.CheckDir(); msg != "" {
		t.Fatalf("a normal folder should be fine, got %q", msg)
	}
	if entries, _ := os.ReadDir(s.dir); len(entries) != 0 {
		t.Fatal("the write test must clean up after itself")
	}
}

// ---- credentials stay out of the process list ----

func TestConnForURLUsesEnvironmentNotArguments(t *testing.T) {
	t.Setenv("PGHOST", "stray-host") // must not leak into the tool's environment
	c := connFor(testURL)
	if len(c.args) != 0 {
		t.Fatalf("a postgres:// URL must not be passed as arguments: %v", c.args)
	}
	has := func(kv string) bool {
		for _, e := range c.env {
			if e == kv {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"PGHOST=db.example", "PGPORT=5433", "PGUSER=rexus", "PGPASSWORD=p@ss/w0rd", "PGDATABASE=rexusdb", "PGSSLMODE=require"} {
		if !has(want) {
			t.Errorf("env missing %s", want)
		}
	}
	for _, e := range c.env {
		if e == "PGHOST=stray-host" {
			t.Error("a stray PGHOST from the parent environment must be dropped")
		}
	}
}

func TestRestoreNamesTheDatabase(t *testing.T) {
	// pg_restore connects to nothing unless it is told which database to use.
	if got := connFor(testURL).target(); got != "--dbname=rexusdb" {
		t.Errorf("URL: got %q", got)
	}
	if got := connFor("postgres://rexus@db.example/").target(); got != "--dbname=rexus" {
		t.Errorf("no database in the URL falls back to the user name, got %q", got)
	}
	if got := connFor("host=db user=rexus dbname=other").target(); got != "--dbname=host=db user=rexus dbname=other" {
		t.Errorf("DSN: got %q", got)
	}
	// And the restore call actually carries it, before the file name.
	s := newSvc(t)
	out := filepath.Join(t.TempDir(), "seen")
	s.pgRestore = script(t, `echo "$@" > `+out)
	s.restoreFile(ctx(), "/b/x.dump")
	seen, _ := os.ReadFile(out)
	if !strings.Contains(string(seen), "--dbname=rexusdb /b/x.dump") {
		t.Errorf("the database must be named right before the file: %q", seen)
	}
}

func TestConnForKeyValueDSNFallsBackToAnArgument(t *testing.T) {
	c := connFor("host=db user=rexus dbname=rexus sslmode=disable")
	if len(c.args) != 1 || !strings.HasPrefix(c.args[0], "--dbname=host=db") {
		t.Fatalf("got %v", c.args)
	}
}

func TestPasswordNeverInCommandLine(t *testing.T) {
	s := newSvc(t)
	out := filepath.Join(t.TempDir(), "seen")
	s.pgDump = script(t, `echo "ARGS: $@" > `+out+`; echo "PW: $PGPASSWORD" >> `+out+`; printf data`)
	if _, err := s.dumpToFile(ctx(), "rexus-20261105-120000.dump"); err != nil {
		t.Fatal(err)
	}
	seen, _ := os.ReadFile(out)
	text := string(seen)
	args := text[:strings.Index(text, "PW:")]
	if strings.Contains(args, "p@ss") || strings.Contains(args, "w0rd") {
		t.Fatalf("password leaked into arguments: %s", args)
	}
	if !strings.Contains(text, "PW: p@ss/w0rd") {
		t.Fatalf("password should arrive through PGPASSWORD: %s", text)
	}
	for _, flag := range []string{"--format=custom", "--no-owner", "--no-acl", "--schema=public"} {
		if !strings.Contains(args, flag) {
			t.Errorf("pg_dump should be called with %s: %s", flag, args)
		}
	}
}

func TestRestoreCommand(t *testing.T) {
	s := newSvc(t)
	out := filepath.Join(t.TempDir(), "seen")
	s.pgRestore = script(t, `echo "ARGS: $@" > `+out)
	if err := s.restoreFile(ctx(), "/backups/rexus-20261105-120000.dump"); err != nil {
		t.Fatal(err)
	}
	seen, _ := os.ReadFile(out)
	for _, want := range []string{"--clean", "--if-exists", "--single-transaction", "--no-owner", "--dbname=rexusdb", "/backups/rexus-20261105-120000.dump"} {
		if !strings.Contains(string(seen), want) {
			t.Errorf("pg_restore should be called with %s: %s", want, seen)
		}
	}
	if strings.Contains(string(seen), "p@ss") {
		t.Error("password leaked into pg_restore arguments")
	}
	s.pgRestore = script(t, `echo 'pg_restore: error: could not execute query' >&2; exit 1`)
	if err := s.restoreFile(ctx(), "x.dump"); err == nil || !strings.Contains(err.Error(), "could not execute query") {
		t.Fatalf("restore errors should surface: %v", err)
	}
}

// ---- files, names, rotation ----

func writeFiles(t *testing.T, dir string, names ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("data-"+n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFilesListedNewestFirstAndOnlyBackups(t *testing.T) {
	s := newSvc(t)
	writeFiles(t, s.dir, "rexus-20261101-000000.dump", "rexus-20261103-090000.dump", "rexus-20261102-120000.dump",
		"notes.txt", "rexus-bad.dump", "rexus-20261104-000000.dump.partial", "latest")
	files, err := s.Files()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"rexus-20261103-090000.dump", "rexus-20261102-120000.dump", "rexus-20261101-000000.dump"}
	if strings.Join(names(files), ",") != strings.Join(want, ",") {
		t.Fatalf("got %v want %v", names(files), want)
	}
	if got := files[0].CreatedAt.Format(time.RFC3339); got != "2026-11-03T09:00:00Z" {
		t.Errorf("created time should come from the file name, got %s", got)
	}
	if files[0].SizeBytes == 0 {
		t.Error("size missing")
	}
}

func TestMissingFolderIsJustEmpty(t *testing.T) {
	s := newSvc(t)
	files, err := s.Files()
	if err != nil || len(files) != 0 {
		t.Fatalf("got %v %v", files, err)
	}
}

func TestRotateKeepsTheNewestAndNeverTouchesOtherFiles(t *testing.T) {
	s := newSvc(t)
	writeFiles(t, s.dir,
		"rexus-20261101-000000.dump", "rexus-20261102-000000.dump", "rexus-20261103-000000.dump",
		"rexus-20261104-000000.dump", "rexus-20261105-000000.dump", "rexus-20261106-000000.dump",
		"photo.jpg", "rexus-notes.dump", "rexus-20261101-000000.dump.partial")
	removed, err := s.Rotate(3)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 3 {
		t.Fatalf("removed %v", removed)
	}
	files, _ := s.Files()
	want := "rexus-20261106-000000.dump,rexus-20261105-000000.dump,rexus-20261104-000000.dump"
	if strings.Join(names(files), ",") != want {
		t.Fatalf("kept %v", names(files))
	}
	for _, other := range []string{"photo.jpg", "rexus-notes.dump", "rexus-20261101-000000.dump.partial"} {
		if _, err := os.Stat(filepath.Join(s.dir, other)); err != nil {
			t.Errorf("rotation must never delete %s", other)
		}
	}
	if removed, _ := s.Rotate(3); len(removed) != 0 {
		t.Error("rotating again with nothing extra removes nothing")
	}
	if removed, _ := s.Rotate(1); len(removed) != 2 {
		t.Errorf("keep=1 should leave one, removed %v", removed)
	}
}

func TestFreeNameAvoidsCollisions(t *testing.T) {
	s := newSvc(t)
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	if got := s.freeName(at); got != "rexus-20261105-120000.dump" {
		t.Fatalf("got %s", got)
	}
	writeFiles(t, s.dir, "rexus-20261105-120000.dump")
	if got := s.freeName(at); got != "rexus-20261105-120001.dump" {
		t.Fatalf("a taken name moves forward one second, got %s", got)
	}
	writeFiles(t, s.dir, "rexus-20261105-120001.dump.partial")
	if got := s.freeName(at); got != "rexus-20261105-120002.dump" {
		t.Fatalf("a half-written file also blocks the name, got %s", got)
	}
	if !fileRe.MatchString(s.freeName(at)) {
		t.Fatal("generated names must match the backup pattern")
	}
}

func TestResolveFileAcceptsOnlyRealBackupNames(t *testing.T) {
	s := newSvc(t)
	writeFiles(t, s.dir, "rexus-20261105-120000.dump")
	secret := filepath.Join(filepath.Dir(s.dir), "rexus-20261105-120000.dump")
	os.WriteFile(secret, []byte("outside"), 0o600)

	if p, err := s.ResolveFile("rexus-20261105-120000.dump"); err != nil || p != filepath.Join(s.dir, "rexus-20261105-120000.dump") {
		t.Fatalf("valid name: %v %v", p, err)
	}
	for _, bad := range []string{
		"../rexus-20261105-120000.dump", "/etc/passwd", "sub/rexus-20261105-120000.dump", "rexus-20261105-120000.dump/..",
		"rexus-20261105-120000.dump.partial", "backup.sql", "", "rexus-20261105-999999.dump.sh", "..",
	} {
		if _, err := s.ResolveFile(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
	if _, err := s.ResolveFile("rexus-20260101-000000.dump"); err == nil {
		t.Error("a missing file must be reported")
	}
}

func TestCleanPartialsRemovesOnlyLeftovers(t *testing.T) {
	s := newSvc(t)
	writeFiles(t, s.dir, "rexus-20261105-120000.dump", "rexus-20261105-130000.dump.partial", "other.partial")
	s.cleanPartials()
	files, _ := os.ReadDir(s.dir)
	var got []string
	for _, f := range files {
		got = append(got, f.Name())
	}
	if strings.Join(got, ",") != "other.partial,rexus-20261105-120000.dump" {
		t.Fatalf("got %v", got)
	}
}

// ---- the traffic light and the schedule ----

func TestState(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	cases := []struct {
		name         string
		interval     int
		success      *time.Time
		failed, any_ bool
		want         string
	}{
		{"never ran", 360, nil, false, false, "none"},
		{"latest attempt failed", 360, ago(time.Hour), true, true, "failed"},
		{"failed and no good one", 360, nil, true, true, "failed"},
		{"fresh", 360, ago(30 * time.Minute), false, true, "ok"},
		{"just under 2x interval", 60, ago(119 * time.Minute), false, true, "ok"},
		{"older than 2x interval", 60, ago(121 * time.Minute), false, true, "stale"},
		{"manual only is never stale", 0, ago(90 * 24 * time.Hour), false, true, "ok"},
		{"manual only still fails", 0, ago(time.Hour), true, true, "failed"},
	}
	for _, c := range cases {
		if got := State(now, c.interval, c.success, c.failed, c.any_); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestNextRun(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	rec := func(status string, ago time.Duration) *store.BackupRecord {
		return &store.BackupRecord{Status: status, StartedAt: now.Add(-ago)}
	}
	cases := []struct {
		name     string
		last     *store.BackupRecord
		interval int
		wantDue  bool
		wantIn   time.Duration // when it is next due, relative to now
	}{
		{"manual only never runs", rec("success", 99*time.Hour), 0, false, 0},
		{"first ever backup is due at once", nil, 360, true, 0},
		{"recent success waits", rec("success", 5*time.Minute), 15, false, 10 * time.Minute},
		{"interval elapsed", rec("success", 20*time.Minute), 15, true, -5 * time.Minute},
		{"failure retries within 15 min, not a full day", rec("failed", 16*time.Minute), 1440, true, -time.Minute},
		{"failure too recent to retry", rec("failed", 10*time.Minute), 1440, false, 5 * time.Minute},
		{"failure with a short interval uses the interval", rec("failed", 10*time.Minute), 15, false, 5 * time.Minute},
	}
	for _, c := range cases {
		due, at := nextRun(c.last, c.interval, now)
		if due != c.wantDue {
			t.Errorf("%s: due=%v want %v", c.name, due, c.wantDue)
		}
		if c.interval != 0 && at.Sub(now) != c.wantIn {
			t.Errorf("%s: next at now%+v want now%+v", c.name, at.Sub(now), c.wantIn)
		}
	}
}

func TestValidateSettings(t *testing.T) {
	for _, iv := range AllowedIntervals {
		if err := ValidateSettings(Settings{IntervalMinutes: iv, Keep: 10}); err != nil {
			t.Errorf("interval %d should be allowed: %v", iv, err)
		}
	}
	for _, bad := range []Settings{{7, 10}, {-1, 10}, {60, 0}, {60, 501}, {1441, 5}} {
		if err := ValidateSettings(bad); err == nil {
			t.Errorf("%+v should be rejected", bad)
		}
	}
	if ValidateSettings(Settings{IntervalMinutes: DefaultIntervalMinutes, Keep: DefaultKeep}) != nil {
		t.Error("the defaults must be valid")
	}
}

func TestToolErrorIsReadable(t *testing.T) {
	long := strings.Repeat("x", 2000)
	err := toolError("pg_dump", os.ErrInvalid, "line1\nline2\nline3\nline4\nline5\n"+long)
	if strings.Contains(err.Error(), "line1") || len(err.Error()) > 700 {
		t.Fatalf("only the last few lines, shortened: %d chars: %v", len(err.Error()), err)
	}
	if err := toolError("pg_dump", os.ErrInvalid, ""); !strings.Contains(err.Error(), "failed") {
		t.Fatalf("got %v", err)
	}
}

// Backups can be switched on and off while Rexus runs: the service asks every time.
func TestEnabledFollowsTheLiveSwitch(t *testing.T) {
	on := false
	s := &Service{enabledFn: func() bool { return on }}
	if s.Enabled() {
		t.Fatal("switched off: Enabled() must be false")
	}
	if err := s.Trigger("manual", nil); err != ErrDisabled {
		t.Fatalf("switched off: Trigger returned %v, want ErrDisabled", err)
	}
	on = true
	if !s.Enabled() {
		t.Fatal("switched on: Enabled() must follow without a restart")
	}
	// the plain flag (the command line) still works when no live switch is given
	if !(&Service{enabled: true}).Enabled() || (&Service{}).Enabled() {
		t.Fatal("the fixed flag must still be honoured")
	}
}
