// Package appsettings holds the Rexus settings the owner or an admin can change from the Settings page.
//
// Each one has a default taken from the environment (.env). A value saved in the database overrides that
// default, and clearing it goes back to the default. Everything that needs a setting calls Get() when it
// needs it instead of keeping its own copy, so a change takes effect at once, without a restart.
//
// Only settings that cannot lock anyone out belong here: the company name, the public URL and the three
// module switches (Vault, Scheduler, Backups). Anything needed before the database is reachable
// (DATABASE_URL, REXUS_MASTER_KEY, REXUS_PORT, REXUS_ENV) and the security policy stay in the environment.
package appsettings

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

// key is where the overrides live in the settings table.
const key = "instance"

// Values are the settings as they apply right now.
type Values struct {
	CompanyName string
	BaseURL     string // "https://rexus.example.com", no trailing slash

	// Module switches. A module that is off disappears from the UI and the API; its data stays in the database.
	ModuleVault     bool // secrets, environments, and the deploy tokens that read them
	ModuleScheduler bool // user-defined jobs (health checks always run)
	BackupEnabled   bool // scheduled and manual backups
}

// SecureCookies reports whether session cookies should carry the Secure flag. It follows the public URL.
func (v Values) SecureCookies() bool { return strings.HasPrefix(v.BaseURL, "https://") }

// Source says where a value comes from.
type Source string

const (
	FromEnv Source = "env" // the default from .env
	FromUI  Source = "ui"  // saved from the Settings page
)

// overrides is what is stored: only the settings that were changed from the page. nil = use the default.
type overrides struct {
	CompanyName     *string `json:"company_name,omitempty"`
	BaseURL         *string `json:"base_url,omitempty"`
	ModuleVault     *bool   `json:"module_vault,omitempty"`
	ModuleScheduler *bool   `json:"module_scheduler,omitempty"`
	BackupEnabled   *bool   `json:"backup_enabled,omitempty"`
}

func (o overrides) empty() bool {
	return o.CompanyName == nil && o.BaseURL == nil && o.ModuleVault == nil && o.ModuleScheduler == nil && o.BackupEnabled == nil
}

// Patch is a change request. For the two text settings, nil leaves a setting as it is, an empty string clears
// the override (the default from .env applies again) and anything else is validated and saved. For the module
// switches, nil leaves one as it is and true or false saves it; ResetModules clears all three at once.
type Patch struct {
	CompanyName *string
	BaseURL     *string

	ModuleVault     *bool
	ModuleScheduler *bool
	BackupEnabled   *bool
	ResetModules    bool // applied first, so a switch given in the same patch still wins
}

// Store is the part of the database layer this package needs (the settings key/value table).
type Store interface {
	GetSetting(ctx context.Context, key string, dest any) (ok bool, err error)
	SetSetting(ctx context.Context, key string, value any) error
	DeleteSetting(ctx context.Context, key string) error
}

// Service keeps the current settings. It is safe for concurrent use.
type Service struct {
	store    Store
	defaults Values

	mu   sync.Mutex // serialises changes; guards over
	over overrides
	cur  atomic.Pointer[Values]
}

// New starts with the defaults from the environment. Call Load to apply what is saved in the database.
func New(st Store, defaults Values) *Service {
	s := &Service{store: st, defaults: defaults}
	d := defaults
	s.cur.Store(&d)
	return s
}

// Get returns the current values.
func (s *Service) Get() Values { return *s.cur.Load() }

// Defaults returns the values from the environment, which apply wherever nothing is saved.
func (s *Service) Defaults() Values { return s.defaults }

// Sources reports, per setting, whether the value comes from the environment or was saved from the page.
func (s *Service) Sources() map[string]Source {
	s.mu.Lock()
	defer s.mu.Unlock()
	src := func(set bool) Source {
		if set {
			return FromUI
		}
		return FromEnv
	}
	return map[string]Source{
		"company_name":     src(s.over.CompanyName != nil),
		"base_url":         src(s.over.BaseURL != nil),
		"module_vault":     src(s.over.ModuleVault != nil),
		"module_scheduler": src(s.over.ModuleScheduler != nil),
		"backup_enabled":   src(s.over.BackupEnabled != nil),
	}
}

// Load reads the saved overrides and applies them. A saved value that no longer validates is ignored (the
// default applies), so a bad row can never stop Rexus from starting.
func (s *Service) Load(ctx context.Context) error {
	var o overrides
	if _, err := s.store.GetSetting(ctx, key, &o); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.over = s.sanitize(o)
	s.apply()
	return nil
}

// Watch reloads the overrides every so often until ctx ends, so a change made from the command line (or by
// another process) shows up without a restart. A failed reload keeps what is current.
func (s *Service) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = s.Load(ctx)
		}
	}
}

// Update validates and saves a change. Nothing changes unless all of it is valid and saved.
func (s *Service) Update(ctx context.Context, p Patch) (Values, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.over
	if p.ResetModules {
		next.ModuleVault, next.ModuleScheduler, next.BackupEnabled = nil, nil, nil
	}
	if p.ModuleVault != nil {
		next.ModuleVault = p.ModuleVault
	}
	if p.ModuleScheduler != nil {
		next.ModuleScheduler = p.ModuleScheduler
	}
	if p.BackupEnabled != nil {
		next.BackupEnabled = p.BackupEnabled
	}
	if p.CompanyName != nil {
		if *p.CompanyName == "" {
			next.CompanyName = nil
		} else {
			v, err := ValidateCompanyName(*p.CompanyName)
			if err != nil {
				return Values{}, err
			}
			next.CompanyName = &v
		}
	}
	if p.BaseURL != nil {
		if *p.BaseURL == "" {
			next.BaseURL = nil
		} else {
			v, err := ValidateBaseURL(*p.BaseURL)
			if err != nil {
				return Values{}, err
			}
			next.BaseURL = &v
		}
	}
	if err := s.save(ctx, next); err != nil {
		return Values{}, err
	}
	s.over = next
	return s.apply(), nil
}

// Reset removes every override, so the defaults from the environment apply again.
func (s *Service) Reset(ctx context.Context) (Values, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.DeleteSetting(ctx, key); err != nil {
		return Values{}, err
	}
	s.over = overrides{}
	return s.apply(), nil
}

func (s *Service) save(ctx context.Context, o overrides) error {
	if o.empty() {
		return s.store.DeleteSetting(ctx, key)
	}
	return s.store.SetSetting(ctx, key, o)
}

// apply recomputes the current values from the defaults and the overrides. The caller holds mu.
func (s *Service) apply() Values {
	v := s.defaults
	if s.over.CompanyName != nil {
		v.CompanyName = *s.over.CompanyName
	}
	if s.over.BaseURL != nil {
		v.BaseURL = *s.over.BaseURL
	}
	if s.over.ModuleVault != nil {
		v.ModuleVault = *s.over.ModuleVault
	}
	if s.over.ModuleScheduler != nil {
		v.ModuleScheduler = *s.over.ModuleScheduler
	}
	if s.over.BackupEnabled != nil {
		v.BackupEnabled = *s.over.BackupEnabled
	}
	s.cur.Store(&v)
	return v
}

// sanitize drops saved values that don't validate.
func (s *Service) sanitize(o overrides) overrides {
	var out overrides
	out.ModuleVault = o.ModuleVault
	out.ModuleScheduler = o.ModuleScheduler
	out.BackupEnabled = o.BackupEnabled
	if o.CompanyName != nil {
		if v, err := ValidateCompanyName(*o.CompanyName); err == nil {
			out.CompanyName = &v
		}
	}
	if o.BaseURL != nil {
		if v, err := ValidateBaseURL(*o.BaseURL); err == nil {
			out.BaseURL = &v
		}
	}
	return out
}

// InvalidError is a problem with what was asked for, as opposed to a failure to save it.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

func invalid(format string, a ...any) error { return &InvalidError{Msg: fmt.Sprintf(format, a...)} }

// MaxCompanyNameLen is the longest company name, in characters.
const MaxCompanyNameLen = 80

// ValidateCompanyName trims the name and checks it is 1 to 80 characters with no control characters.
func ValidateCompanyName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > MaxCompanyNameLen {
		return "", invalid("the company name must be 1 to %d characters", MaxCompanyNameLen)
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", invalid("the company name can't contain control characters")
		}
	}
	return s, nil
}

// ValidateBaseURL checks the public URL is a plain http:// or https:// address (host and optional port, no
// path, query or credentials) and returns it in its canonical form: lower-case, no trailing slash.
func ValidateBaseURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		return "", invalid("the public URL is too long")
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", invalid("the public URL must start with http:// or https:// and name a host, like https://rexus.example.com")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", invalid("the public URL can only be an address like https://rexus.example.com, without a path, query or login")
	}
	if u.Hostname() == "" {
		return "", invalid("the public URL must name a host")
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}
