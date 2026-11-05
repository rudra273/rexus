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
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"

	"rexus/internal/auth"
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

	if cfg.LoginOwnerOnly {
		n, err := st.RevokeNonOwnerSessions(ctx)
		if err != nil {
			return err
		}
		if n > 0 {
			log.Warn("lockdown mode: revoked non-owner sessions", "count", n)
		}
	}

	engine := scheduler.New(st, keys, log, cfg.ModuleScheduler)
	srv := server.New(cfg, st, keys, engine, log, version)
	if err := srv.InitSetup(ctx); err != nil {
		return err
	}

	engineCtx, stopEngine := context.WithCancel(context.Background())
	engine.Start(engineCtx)

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
		log.Info("listening", "addr", httpSrv.Addr, "url", cfg.BaseURL)
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
			fmt.Println("Log in at", cfg.BaseURL, "— you'll be asked to set up 2FA on first login.")
		} else {
			fmt.Println("Log in at", cfg.BaseURL)
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
		fmt.Println("Log in at", cfg.BaseURL, "and set up 2FA again.")
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
