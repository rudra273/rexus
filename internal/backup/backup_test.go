package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	return &Service{dbURL: testURL, pgDump: script(t, dumpOK), pgRestore: script(t, listUsers)}
}

func ctx() context.Context { return context.Background() }

// tmpFile is the empty private file Create hands to dump.
func tmpFile(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "rexus-backup-*.partial")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	return f.Name()
}

// ---- making a backup ----

func TestDumpWritesThePrivateFile(t *testing.T) {
	s := newSvc(t)
	path := tmpFile(t)
	size, err := s.dump(ctx(), path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != size || size != int64(len("PGDMP fake data")) {
		t.Errorf("size mismatch: file %d, reported %d", info.Size(), size)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("backup must be private (0600), got %v", info.Mode().Perm())
	}
}

func TestFailedDumpSurfacesTheReason(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpFails)
	_, err := s.dump(ctx(), tmpFile(t))
	if err == nil || !strings.Contains(err.Error(), "password authentication failed") {
		t.Fatalf("the reason from pg_dump should surface: %v", err)
	}
}

func TestEmptyDumpIsAFailure(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpEmpty)
	if _, err := s.dump(ctx(), tmpFile(t)); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("got %v", err)
	}
}

func TestMissingPgDumpExplainsWhatToDo(t *testing.T) {
	s := newSvc(t)
	s.pgDump = "/definitely/not/installed/pg_dump"
	_, err := s.dump(ctx(), tmpFile(t))
	if err == nil || !strings.Contains(err.Error(), "isn't installed") {
		t.Fatalf("got %v", err)
	}
}

func TestVersionMismatchGetsAHint(t *testing.T) {
	s := newSvc(t)
	s.pgDump = script(t, dumpV)
	_, err := s.dump(ctx(), tmpFile(t))
	if err == nil || !strings.Contains(err.Error(), "same version") {
		t.Fatalf("got %v", err)
	}
}

func TestBackupThatFailsVerificationIsRefused(t *testing.T) {
	s := newSvc(t)
	s.pgRestore = script(t, listOther) // readable archive, but not Rexus data
	_, err := s.dump(ctx(), tmpFile(t))
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Fatalf("got %v", err)
	}
}

func TestDumpIntoAMissingFileFailsClearly(t *testing.T) {
	s := newSvc(t)
	if _, err := s.dump(ctx(), filepath.Join(t.TempDir(), "nope", "x")); err == nil {
		t.Fatal("expected an error")
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
	if _, err := s.dump(ctx(), tmpFile(t)); err != nil {
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

func TestState(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	cases := []struct {
		name         string
		success      *time.Time
		failed, any_ bool
		want         string
	}{
		{"never ran", nil, false, false, "none"},
		{"latest attempt failed", ago(time.Hour), true, true, "failed"},
		{"failed and no good one", nil, true, true, "failed"},
		{"fresh", ago(30 * time.Minute), false, true, "ok"},
		{"six days old", ago(6 * 24 * time.Hour), false, true, "ok"},
		{"older than a week", ago(8 * 24 * time.Hour), false, true, "stale"},
	}
	for _, c := range cases {
		if got := State(now, c.success, c.failed, c.any_); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
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
