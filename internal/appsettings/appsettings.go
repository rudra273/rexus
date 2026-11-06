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
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
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

	// Look and feel, shared by everyone unless a person picks their own in Profile.
	Timezone    string // IANA name; "" = each person's browser
	DateFormat  string // system | iso | dmy | mdy
	AccentColor string // "#rrggbb"; "" = the built-in green
	Logo        string // data URI of the uploaded logo; "" = the Rexus logo
	LogoVersion string // short hash of Logo, so browsers fetch a new one when it changes

	SessionHours int // how long a login lasts without activity
}

// SessionTTL is how long a login stays valid without activity.
func (v Values) SessionTTL() time.Duration {
	h := v.SessionHours
	if h < 1 {
		h = DefaultSessionHours
	}
	return time.Duration(h) * time.Hour
}

const (
	DefaultSessionHours = 8
	MaxSessionHours     = 720 // 30 days
	MaxLogoBytes        = 256 << 10
)

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

	Timezone     *string `json:"timezone,omitempty"`
	DateFormat   *string `json:"date_format,omitempty"`
	AccentColor  *string `json:"accent_color,omitempty"`
	Logo         *string `json:"logo,omitempty"`
	SessionHours *int    `json:"session_hours,omitempty"`
}

func (o overrides) empty() bool {
	return o.CompanyName == nil && o.BaseURL == nil && o.ModuleVault == nil && o.ModuleScheduler == nil && o.BackupEnabled == nil &&
		o.Timezone == nil && o.DateFormat == nil && o.AccentColor == nil && o.Logo == nil && o.SessionHours == nil
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

	// Look and feel and sessions. Like the two text settings above: nil leaves it, "" (or 0 for SessionHours)
	// goes back to the default, anything else is validated and saved.
	Timezone     *string
	DateFormat   *string
	AccentColor  *string
	Logo         *string
	SessionHours *int
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
		"timezone":         src(s.over.Timezone != nil),
		"date_format":      src(s.over.DateFormat != nil),
		"accent_color":     src(s.over.AccentColor != nil),
		"logo":             src(s.over.Logo != nil),
		"session_hours":    src(s.over.SessionHours != nil),
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
	for _, f := range []struct {
		in  *string
		out **string
		val func(string) (string, error)
	}{
		{p.Timezone, &next.Timezone, ValidateTimezone},
		{p.DateFormat, &next.DateFormat, ValidateDateFormat},
		{p.AccentColor, &next.AccentColor, ValidateAccentColor},
		{p.Logo, &next.Logo, ValidateLogo},
	} {
		if f.in == nil {
			continue
		}
		if *f.in == "" {
			*f.out = nil
			continue
		}
		v, err := f.val(*f.in)
		if err != nil {
			return Values{}, err
		}
		*f.out = &v
	}
	if p.SessionHours != nil {
		if *p.SessionHours == 0 {
			next.SessionHours = nil
		} else {
			if *p.SessionHours < 1 || *p.SessionHours > MaxSessionHours {
				return Values{}, invalid("the session length must be between 1 hour and %d hours", MaxSessionHours)
			}
			h := *p.SessionHours
			next.SessionHours = &h
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
	if s.over.Timezone != nil {
		v.Timezone = *s.over.Timezone
	}
	if s.over.DateFormat != nil {
		v.DateFormat = *s.over.DateFormat
	}
	if s.over.AccentColor != nil {
		v.AccentColor = *s.over.AccentColor
	}
	if s.over.Logo != nil {
		v.Logo = *s.over.Logo
	}
	if s.over.SessionHours != nil {
		v.SessionHours = *s.over.SessionHours
	}
	if v.DateFormat == "" {
		v.DateFormat = "system"
	}
	if v.SessionHours < 1 {
		v.SessionHours = DefaultSessionHours
	}
	v.LogoVersion = ""
	if v.Logo != "" {
		sum := sha256.Sum256([]byte(v.Logo))
		v.LogoVersion = hex.EncodeToString(sum[:4])
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
	for _, f := range []struct {
		in  *string
		out **string
		val func(string) (string, error)
	}{
		{o.Timezone, &out.Timezone, ValidateTimezone},
		{o.DateFormat, &out.DateFormat, ValidateDateFormat},
		{o.AccentColor, &out.AccentColor, ValidateAccentColor},
		{o.Logo, &out.Logo, ValidateLogo},
	} {
		if f.in == nil {
			continue
		}
		if v, err := f.val(*f.in); err == nil {
			*f.out = &v
		}
	}
	if o.SessionHours != nil && *o.SessionHours >= 1 && *o.SessionHours <= MaxSessionHours {
		out.SessionHours = o.SessionHours
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

// ValidateTimezone checks it is a real IANA timezone name such as "Europe/London".
func ValidateTimezone(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > 64 || s == "Local" {
		return "", invalid("that isn't a timezone")
	}
	if _, err := time.LoadLocation(s); err != nil {
		return "", invalid("%q isn't a known timezone", s)
	}
	return s, nil
}

// ValidateDateFormat accepts the same four styles the Profile page offers.
func ValidateDateFormat(s string) (string, error) {
	switch s {
	case "system", "iso", "dmy", "mdy":
		return s, nil
	}
	return "", invalid("the date format must be system, iso, dmy or mdy")
}

var accentRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// ValidateAccentColor checks it is a #rrggbb colour and returns it in lower case.
func ValidateAccentColor(s string) (string, error) {
	s = strings.TrimSpace(s)
	if !accentRe.MatchString(s) {
		return "", invalid("the accent colour must look like #10b981")
	}
	return strings.ToLower(s), nil
}

const dataPrefix = "data:"

// ParseLogo splits a logo data URI into its content type and bytes.
func ParseLogo(dataURI string) (contentType string, body []byte, err error) {
	rest, ok := strings.CutPrefix(dataURI, dataPrefix)
	if !ok {
		return "", nil, invalid("the logo must be an image file")
	}
	meta, b64, ok := strings.Cut(rest, ",")
	if !ok || !strings.HasSuffix(meta, ";base64") {
		return "", nil, invalid("the logo must be an image file")
	}
	contentType = strings.TrimSuffix(meta, ";base64")
	if base64.StdEncoding.DecodedLen(len(b64)) > MaxLogoBytes+3 {
		return "", nil, invalid("the logo is too large (the limit is %d KB)", MaxLogoBytes>>10)
	}
	body, err = base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", nil, invalid("the logo file is damaged")
	}
	if len(body) == 0 || len(body) > MaxLogoBytes {
		return "", nil, invalid("the logo must be between 1 byte and %d KB", MaxLogoBytes>>10)
	}
	return contentType, body, nil
}

// ValidateLogo accepts a PNG, JPEG, WebP or SVG image of up to 256 KB, given as a base64 data URI. The bytes must
// really be that kind of image, not just labelled as one.
func ValidateLogo(s string) (string, error) {
	ct, body, err := ParseLogo(strings.TrimSpace(s))
	if err != nil {
		return "", err
	}
	switch ct {
	case "image/png", "image/jpeg", "image/webp":
		if http.DetectContentType(body) != ct {
			return "", invalid("that file isn't a real %s image", strings.TrimPrefix(ct, "image/"))
		}
	case "image/svg+xml":
		if !strings.Contains(strings.ToLower(string(body)), "<svg") {
			return "", invalid("that file isn't a real SVG image")
		}
	default:
		return "", invalid("the logo must be a PNG, JPEG, WebP or SVG image")
	}
	return strings.TrimSpace(s), nil
}
