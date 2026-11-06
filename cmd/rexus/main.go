// Command rexus is the single Rexus binary: web UI + API + scheduler
// (`rexus serve`) and the admin CLI (`rexus owner …`, `rexus keygen`, …).
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"

	"rexus/internal/alerts"
	"rexus/internal/appsettings"
	"rexus/internal/auth"
	"rexus/internal/backup"
	"rexus/internal/config"
	"rexus/internal/crypto"
	"rexus/internal/db"
	"rexus/internal/scheduler"
	"rexus/internal/server"
	"rexus/internal/store"
)

// version is set at build time: -ldflags "-X main.version=v0.1.0"
var version = "dev"

const usage = `Rexus — self-hosted control panel for your projects

Usage:
  rexus serve                       Start web UI + API + scheduler
  rexus owner create --email EMAIL  Create the owner (prompts for password)
  rexus owner reset                 Reset the owner's password and 2FA
  rexus owner transfer --to EMAIL   Hand ownership to another active user
  rexus settings show               Show the company name and public URL in use, and where each comes from
  rexus settings reset              Clear settings saved from the web UI (back to the .env values)
  rexus migrate                    Run database migrations and exit
  rexus keygen                      Generate a new REXUS_MASTER_KEY
  rexus version                     Print version

Configuration is read from env vars (and a .env file in the current folder).
See .env.example.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Print(usage)
		return nil
	}
	switch args[0] {
	case "serve":
		return cmdServe()
	case "owner":
		return cmdOwner(args[1:])
	case "settings":
		return cmdSettings(args[1:])
	case "backup":
		return cmdBackup(args[1:])
	case "restore":
		return cmdRestore(args[1:])
	case "migrate":
		return cmdMigrate()
	case "keygen":
		fmt.Println(crypto.GenerateMasterKey())
		return nil
	case "version", "--version", "-v":
		fmt.Println("rexus", version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
}

func setup() (*config.Config, *slog.Logger, error) {
	if err := config.LoadDotEnv(".env"); err != nil {
		return nil, nil, fmt.Errorf("read .env: %w", err)
	}
	cfg, warnings, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	level := slog.LevelInfo
	if cfg.IsDev() {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)
	for _, w := range warnings {
		log.Warn(w)
	}
	return cfg, log, nil
}

func connect(ctx context.Context, cfg *config.Config, log *slog.Logger) (*pgxpool.Pool, error) {
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, pool, log); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func cmdServe() error {
	cfg, log, err := setup()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Info("starting rexus", "version", version, "env", cfg.Env, "company", cfg.CompanyName)
	for k, v := range cfg.Toggles() {
		log.Info("toggle", "name", k, "value", v)
	}

	pool, err := connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()

	keys, err := crypto.NewKeyring(cfg.MasterKey)
	if err != nil {
		return err
	}
	st := store.New(pool)
	as := loadSettings(ctx, cfg, st, log)

	if cfg.LoginOwnerOnly {
		n, err := st.RevokeNonOwnerSessions(ctx)
		if err != nil {
			return err
		}
		if n > 0 {
			log.Warn("lockdown mode: revoked non-owner sessions", "count", n)
		}
	}

	al := newAlerts(cfg, as, st, keys, log)
	bk := backup.New(st, log, al, backup.Options{Enabled: cfg.BackupEnabled, Dir: cfg.BackupDir, DatabaseURL: cfg.DatabaseURL})
	engine := scheduler.New(st, keys, log, cfg.ModuleScheduler, al)
	srv := server.New(cfg, as, st, keys, engine, al, bk, log, version)
	if err := srv.InitSetup(ctx); err != nil {
		return err
	}

	engineCtx, stopEngine := context.WithCancel(context.Background())
	engine.Start(engineCtx)
	go as.Watch(engineCtx, 30*time.Second) // picks up a change made from the command line
	al.Start(engineCtx)
	bk.Start(engineCtx)

	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", httpSrv.Addr, "url", as.Get().BaseURL)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-errCh:
		stopEngine()
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	httpSrv.Shutdown(shutdownCtx)
	stopEngine()
	engine.Wait(30 * time.Second)
	bk.Wait(30 * time.Second)
	al.Wait(20 * time.Second)
	return nil
}

func cmdMigrate() error {
	cfg, log, err := setup()
	if err != nil {
		return err
	}
	pool, err := connect(context.Background(), cfg, log)
	if err != nil {
		return err
	}
	pool.Close()
	fmt.Println("migrations up to date")
	return nil
}

func cmdOwner(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: rexus owner create --email EMAIL | rexus owner reset | rexus owner transfer --to EMAIL")
	}
	cfg, log, err := setup()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	as := loadSettings(ctx, cfg, st, log)

	switch args[0] {
	case "create":
		fs := flag.NewFlagSet("owner create", flag.ContinueOnError)
		email := fs.String("email", "", "owner email (required)")
		name := fs.String("name", "", "owner name (default: part of email before @)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *email == "" {
			return errors.New("--email is required")
		}
		if exists, err := st.OwnerExists(ctx); err != nil {
			return err
		} else if exists {
			return errors.New("an owner already exists — use `rexus owner reset` to recover access")
		}
		n := strings.TrimSpace(*name)
		if n == "" {
			n, _, _ = strings.Cut(*email, "@")
		}
		pw, err := promptNewPassword()
		if err != nil {
			return err
		}
		hash, err := auth.HashPassword(pw)
		if err != nil {
			return err
		}
		u, err := st.CreateOwner(ctx, *email, n, hash)
		if err != nil {
			return err
		}
		st.Audit(ctx, store.AuditEntry{ActorUserID: &u.ID, Actor: "cli", Action: "setup.owner_created",
			TargetType: "user", TargetID: u.ID, Details: map[string]any{"via": "cli"}})
		fmt.Printf("\nOwner created: %s\n", u.Email)
		if cfg.TwoFARequiredFor("owner") {
			fmt.Println("Log in at", as.Get().BaseURL, "— you'll be asked to set up 2FA on first login.")
		} else {
			fmt.Println("Log in at", as.Get().BaseURL)
		}
		fmt.Println("(If Rexus is already running, the setup screen is now disabled automatically.)")
		return nil

	case "reset":
		fs := flag.NewFlagSet("owner reset", flag.ContinueOnError)
		email := fs.String("email", "", "owner email (optional safety check)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		u, err := st.Owner(ctx)
		if errors.Is(err, store.ErrNotFound) {
			return errors.New("no owner exists yet — use `rexus owner create`")
		}
		if err != nil {
			return err
		}
		if *email != "" && !strings.EqualFold(*email, u.Email) {
			return fmt.Errorf("the owner is not %s", *email)
		}
		fmt.Printf("Resetting password and 2FA for owner %s\n", u.Email)
		pw, err := promptNewPassword()
		if err != nil {
			return err
		}
		hash, err := auth.HashPassword(pw)
		if err != nil {
			return err
		}
		if err := st.SetPassword(ctx, u.ID, hash); err != nil {
			return err
		}
		if err := st.ResetTOTP(ctx, u.ID); err != nil {
			return err
		}
		if err := st.RevokeUserSessions(ctx, u.ID); err != nil {
			return err
		}
		st.Audit(ctx, store.AuditEntry{ActorUserID: &u.ID, Actor: "cli", Action: "owner.reset",
			TargetType: "user", TargetID: u.ID})
		fmt.Println("\nDone. Password changed, 2FA reset, all owner sessions logged out.")
		fmt.Println("Log in at", as.Get().BaseURL, "and set up 2FA again.")
		return nil

	case "transfer":
		fs := flag.NewFlagSet("owner transfer", flag.ContinueOnError)
		to := fs.String("to", "", "email of the user who becomes owner (required)")
		yes := fs.Bool("yes", false, "skip the confirmation prompt")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *to == "" {
			return errors.New("--to is required")
		}
		cur, err := st.Owner(ctx)
		if errors.Is(err, store.ErrNotFound) {
			return errors.New("no owner exists yet — use `rexus owner create`")
		}
		if err != nil {
			return err
		}
		target, err := st.UserByEmail(ctx, *to)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no user with email %s", *to)
		}
		if err != nil {
			return err
		}
		if target.ID == cur.ID {
			return errors.New("that user is already the owner")
		}
		if target.Status != "active" {
			return errors.New("that user is disabled — enable them first")
		}
		if !*yes {
			fmt.Printf("Make %s the owner? %s will become an admin. Type YES to confirm: ", target.Email, cur.Email)
			line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			if strings.TrimSpace(line) != "YES" {
				return errors.New("cancelled")
			}
		}
		if err := st.TransferOwnership(ctx, cur.ID, target.ID); err != nil {
			return err
		}
		st.Audit(ctx, store.AuditEntry{ActorUserID: &cur.ID, Actor: "cli", Action: "owner.transfer",
			TargetType: "user", TargetID: target.ID, Details: map[string]any{"from": cur.Email, "to": target.Email}})
		fmt.Printf("Done. %s is now the owner; %s is an admin.\n", target.Email, cur.Email)
		return nil

	default:
		return fmt.Errorf("unknown owner command %q (use create, reset or transfer)", args[0])
	}
}

// promptNewPassword asks twice on a terminal; when stdin is not a terminal
// (scripts, CI) it reads a single line.
func promptNewPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return "", errors.New("no password provided on stdin")
		}
		pw := strings.TrimRight(line, "\r\n")
		return pw, auth.ValidatePassword(pw)
	}
	for {
		fmt.Printf("New password (%d+ characters): ", auth.MinPasswordLen)
		a, err := term.ReadPassword(fd)
		fmt.Println()
		if err != nil {
			return "", err
		}
		if err := auth.ValidatePassword(string(a)); err != nil {
			fmt.Println(err)
			continue
		}
		fmt.Print("Repeat password: ")
		b, err := term.ReadPassword(fd)
		fmt.Println()
		if err != nil {
			return "", err
		}
		if string(a) != string(b) {
			fmt.Println("passwords don't match, try again")
			continue
		}
		return string(a), nil
	}
}

func newAlerts(cfg *config.Config, as *appsettings.Service, st *store.Store, keys *crypto.Keyring, log *slog.Logger) *alerts.Service {
	identity := func() (string, string) {
		v := as.Get()
		return v.BaseURL, v.CompanyName
	}
	return alerts.New(st, keys, log, identity, alerts.SMTPConfig{
		Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Password: cfg.SMTPPassword, From: cfg.SMTPFrom,
	})
}

// loadSettings starts the settings that can be changed from the web UI: the .env values are the defaults, and
// whatever the owner saved in the database overrides them. If the database can't be read the defaults are used.
func loadSettings(ctx context.Context, cfg *config.Config, st *store.Store, log *slog.Logger) *appsettings.Service {
	as := appsettings.New(st, appsettings.Values{CompanyName: cfg.CompanyName, BaseURL: cfg.BaseURL})
	if err := as.Load(ctx); err != nil {
		log.Warn("couldn't read the settings saved in the web UI; using the values from .env", "error", err)
		return as
	}
	v, src := as.Get(), as.Sources()
	log.Info("instance settings", "company", v.CompanyName, "company_from", src["company_name"], "url", v.BaseURL, "url_from", src["base_url"])
	return as
}

// cmdSettings is the way back in if a setting saved from the web UI causes trouble (for example a public URL
// that stops logins from working): it needs only access to the database, not a login.
func cmdSettings(args []string) error {
	if len(args) != 1 || (args[0] != "show" && args[0] != "reset") {
		return errors.New("usage: rexus settings show | rexus settings reset")
	}
	cfg, log, err := setup()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	as := appsettings.New(st, appsettings.Values{CompanyName: cfg.CompanyName, BaseURL: cfg.BaseURL})
	if err := as.Load(ctx); err != nil {
		return err
	}
	show := func(v appsettings.Values, src map[string]appsettings.Source) {
		fmt.Printf("  Company name: %s  (%s)\n  Public URL:   %s  (%s)\n", v.CompanyName, srcLabel(src["company_name"]), v.BaseURL, srcLabel(src["base_url"]))
	}
	if args[0] == "show" {
		show(as.Get(), as.Sources())
		return nil
	}
	if src := as.Sources(); src["company_name"] == appsettings.FromEnv && src["base_url"] == appsettings.FromEnv {
		fmt.Println("Nothing was saved from the web UI, so the values from .env are already in use:")
		show(as.Get(), as.Sources())
		return nil
	}
	v, err := as.Reset(ctx)
	if err != nil {
		return err
	}
	st.Audit(ctx, store.AuditEntry{Actor: "cli", Action: "settings.reset", TargetType: "settings"})
	fmt.Println("Cleared the settings saved from the web UI. Rexus now uses the values from .env:")
	show(v, as.Sources())
	fmt.Println("A running Rexus picks this up within a minute.")
	return nil
}

func srcLabel(s appsettings.Source) string {
	if s == appsettings.FromUI {
		return "saved in the web UI"
	}
	return "from .env"
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGT"[exp])
}

// dbLabel describes the database without its password, for confirmation prompts.
func dbLabel(dbURL string) string {
	u, err := url.Parse(dbURL)
	if err != nil || u.Host == "" {
		return "the configured database"
	}
	return u.Host + u.Path
}

func cmdBackup(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: rexus backup now | rexus backup list")
	}
	cfg, log, err := setup()
	if err != nil {
		return err
	}
	if cfg.BackupDir == "" {
		return errors.New("REXUS_BACKUP_DIR is not set — it is the folder backups are written to")
	}
	ctx := context.Background()
	pool, err := connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	keys, err := crypto.NewKeyring(cfg.MasterKey)
	if err != nil {
		return err
	}
	st := store.New(pool)
	as := loadSettings(ctx, cfg, st, log)
	al := newAlerts(cfg, as, st, keys, log)
	bk := backup.New(st, log, al, backup.Options{Enabled: true, Dir: cfg.BackupDir, DatabaseURL: cfg.DatabaseURL})

	switch args[0] {
	case "now":
		fmt.Println("Backing up…")
		rec, err := bk.Run(ctx, "manual", nil)
		al.Wait(20 * time.Second) // let a "backup failed" alert go out
		if err != nil {
			return err
		}
		fmt.Printf("Done: %s (%s)\nFolder: %s\n", *rec.FileName, humanSize(*rec.SizeBytes), cfg.BackupDir)
		return nil
	case "list":
		files, err := bk.Files()
		if err != nil {
			return err
		}
		if len(files) == 0 {
			fmt.Println("No backups in", cfg.BackupDir)
			return nil
		}
		for _, f := range files {
			fmt.Printf("%s  %9s  %s\n", f.CreatedAt.Format("2006-01-02 15:04 UTC"), humanSize(f.SizeBytes), f.Name)
		}
		return nil
	}
	return fmt.Errorf("unknown backup command %q (use now or list)", args[0])
}

func cmdRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	file := fs.String("file", "", "path to a backup file (required)")
	yes := fs.Bool("yes", false, "skip the confirmation prompt")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *file == "" {
		return errors.New("--file is required, e.g. rexus restore --file /backups/rexus-20261105-120000.dump")
	}
	path, err := filepath.Abs(*file)
	if err != nil {
		return err
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("can't read %s", path)
	}

	cfg, log, err := setup()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	keys, err := crypto.NewKeyring(cfg.MasterKey)
	if err != nil {
		return err
	}
	st := store.New(pool)
	bk := backup.New(st, log, nil, backup.Options{Dir: filepath.Dir(path), DatabaseURL: cfg.DatabaseURL})

	empty, err := bk.DatabaseIsEmpty(ctx)
	if err != nil {
		return err
	}
	if !empty {
		return backup.ErrNotEmpty
	}
	if !*yes {
		fmt.Printf("Restore %s into the database %s? Type YES to confirm: ", filepath.Base(path), dbLabel(cfg.DatabaseURL))
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if strings.TrimSpace(line) != "YES" {
			return errors.New("cancelled")
		}
	}
	fmt.Println("Restoring…")
	if err := bk.Restore(ctx, path); err != nil {
		return err
	}
	pool.Reset()
	if err := db.Migrate(ctx, pool, log); err != nil {
		return fmt.Errorf("the backup was restored, but updating the database failed: %w", err)
	}

	var users, projects, secrets int
	pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM projects), (SELECT count(*) FROM secrets)`).Scan(&users, &projects, &secrets)
	st.Audit(ctx, store.AuditEntry{Actor: "cli", Action: "backup.restore", TargetType: "backup", TargetID: filepath.Base(path),
		Details: map[string]any{"file": filepath.Base(path), "via": "cli"}})
	fmt.Printf("Restored %s: %d users, %d projects, %d secrets.\n", filepath.Base(path), users, projects, secrets)
	if checked, kerr := backup.CheckMasterKey(ctx, st, keys); checked && kerr != nil {
		fmt.Println("\nWARNING:", backup.KeyWarning)
	}
	fmt.Println("Start Rexus and log in with the accounts from the backup.")
	return nil
}
