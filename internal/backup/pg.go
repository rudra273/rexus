package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// pgConn is how to point a PostgreSQL command-line tool at the database.
// For a postgres:// URL everything goes in PG* environment variables, so the
// password never appears in the process list. A key=value connection string
// has to be passed as an argument instead.
type pgConn struct {
	env  []string
	args []string // --dbname=<connection string>, only for key=value DSNs
	// dbname is the database to connect to. pg_restore (unlike pg_dump) does not
	// connect from the PG* variables alone: it must be given a database explicitly.
	dbname string
}

// target returns the --dbname argument pg_restore needs.
func (c pgConn) target() string {
	if len(c.args) > 0 {
		return c.args[0]
	}
	return "--dbname=" + c.dbname
}

func connFor(dbURL string) pgConn {
	// Start from the current environment, minus any PG* variables that could
	// point the tool somewhere else.
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PG") {
			env = append(env, kv)
		}
	}
	env = append(env, "PGCONNECT_TIMEOUT=15", "PGAPPNAME=rexus")

	u, err := url.Parse(dbURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return pgConn{env: env, args: []string{"--dbname=" + dbURL}}
	}
	q := u.Query()
	set := func(k, v string) {
		if v != "" {
			env = append(env, k+"="+v)
		}
	}
	host := u.Hostname()
	if host == "" {
		host = q.Get("host") // unix socket directory
	}
	set("PGHOST", host)
	set("PGPORT", u.Port())
	if u.User != nil {
		set("PGUSER", u.User.Username())
		pw, _ := u.User.Password()
		set("PGPASSWORD", pw)
	}
	dbname := strings.TrimPrefix(u.Path, "/")
	if dbname == "" && u.User != nil {
		dbname = u.User.Username() // libpq's default: a database named like the user
	}
	set("PGDATABASE", dbname)
	set("PGSSLMODE", q.Get("sslmode"))
	set("PGSSLROOTCERT", q.Get("sslrootcert"))
	return pgConn{env: env, dbname: dbname}
}

// limitBuf keeps the first 8 KB written to it (tool error output).
type limitBuf struct{ bytes.Buffer }

func (b *limitBuf) Write(p []byte) (int, error) {
	if room := 8192 - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// reason turns a file-system error into its short human text ("permission denied").
func reason(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
}

// toolError turns a failed pg_dump / pg_restore run into a message people can act on.
func toolError(tool string, err error, stderr string) error {
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s isn't installed — the Rexus Docker image includes it; otherwise install the PostgreSQL client tools", tool)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s took too long and was stopped", tool)
	}
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return fmt.Errorf("%s failed: %v", tool, err)
	}
	lines := strings.Split(msg, "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	msg = clip(strings.Join(lines, " · "), 500)
	if strings.Contains(stderr, "server version mismatch") {
		msg += " (the PostgreSQL client tools must be the same version as — or newer than — your database)"
	}
	return fmt.Errorf("%s: %s", tool, msg)
}

var usersTableRe = regexp.MustCompile(`TABLE public users\b`)

// verify makes sure a file is a readable PostgreSQL archive that contains
// Rexus's data, without touching any database.
func (s *Service) verify(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var out bytes.Buffer
	var stderr limitBuf
	cmd := exec.CommandContext(ctx, s.pgRestore, "--list", path)
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		return toolError("pg_restore", err, stderr.String())
	}
	if !usersTableRe.Match(out.Bytes()) {
		return errors.New("this doesn't look like a Rexus backup (no users table in it)")
	}
	return nil
}

// dumpToFile writes a backup named `name` into the backup folder. It writes to
// a .partial file and renames it only once the dump finished and verified, so
// a crash or full disk can never leave something that looks like a good backup.
func (s *Service) dumpToFile(ctx context.Context, name string) (int64, error) {
	if s.dir == "" {
		return 0, errors.New("REXUS_BACKUP_DIR is not set")
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return 0, fmt.Errorf("can't create the backup folder %s: %s", s.dir, reason(err))
	}
	final := filepath.Join(s.dir, name)
	part := final + ".partial"
	// 0600: the file holds password hashes and encrypted secrets.
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, fmt.Errorf("can't write to the backup folder %s: %s", s.dir, reason(err))
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(part)
		}
	}()

	ctx, cancel := context.WithTimeout(ctx, dumpTimeout)
	defer cancel()
	c := connFor(s.dbURL)
	args := append([]string{"--format=custom", "--no-owner", "--no-acl", "--schema=public"}, c.args...)
	cmd := exec.CommandContext(ctx, s.pgDump, args...)
	cmd.Env = c.env
	cmd.Stdout = f
	var stderr limitBuf
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, toolError("pg_dump", err, stderr.String())
	}
	if err := f.Sync(); err != nil {
		return 0, fmt.Errorf("can't write to the backup folder %s: %s", s.dir, reason(err))
	}
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() == 0 {
		return 0, errors.New("pg_dump produced an empty file")
	}
	if err := f.Close(); err != nil {
		return 0, fmt.Errorf("can't write to the backup folder %s: %s", s.dir, reason(err))
	}
	if err := s.verify(ctx, part); err != nil {
		return 0, fmt.Errorf("the backup was written but failed verification: %w", err)
	}
	if err := os.Rename(part, final); err != nil {
		return 0, fmt.Errorf("can't finish the backup file: %s", reason(err))
	}
	ok = true
	return info.Size(), nil
}

// restoreFile loads a backup into the database in a single transaction: it
// either all works or nothing changes. --clean only drops the objects that the
// backup itself contains.
func (s *Service) restoreFile(ctx context.Context, path string) error {
	c := connFor(s.dbURL)
	args := []string{"--clean", "--if-exists", "--no-owner", "--no-acl", "--single-transaction", c.target(), path}
	cmd := exec.CommandContext(ctx, s.pgRestore, args...)
	cmd.Env = c.env
	var stderr limitBuf
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return toolError("pg_restore", err, stderr.String())
	}
	return nil
}
