// Package config loads and validates Rexus configuration from env vars.
//
// Rule (plan.md §3): infrastructure, secrets and feature toggles live in env
// vars. Changing any of them requires a restart. Invalid values stop startup.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"

	"rexus/internal/crypto"
)

// 2FA modes (REXUS_2FA_MODE).
const (
	TwoFARequired = "required" // everyone must use 2FA
	TwoFAAdmins   = "admins"   // only owner/admin must use 2FA
	TwoFAOptional = "optional" // users choose
	TwoFAOff      = "off"      // 2FA disabled
)

type Config struct {
	// Infrastructure
	Env         string // production | development
	CompanyName string
	BaseURL     string
	Port        int
	DatabaseURL string
	MasterKey   []byte // 32 bytes, never stored in DB

	// Toggles (plan.md §3.1)
	TwoFAMode       string
	LoginOwnerOnly  bool
	IPAllowlist     []netip.Prefix // nil = allow all
	BackupEnabled   bool
	BackupDir       string
	ModuleScheduler bool
	ModuleVault     bool
}

func (c *Config) IsDev() bool { return c.Env == "development" }

// SecureCookies reports whether session cookies should carry the Secure flag.
func (c *Config) SecureCookies() bool { return strings.HasPrefix(c.BaseURL, "https://") }

// TwoFARequiredFor reports whether a user with the given role must use 2FA.
func (c *Config) TwoFARequiredFor(role string) bool {
	switch c.TwoFAMode {
	case TwoFARequired:
		return true
	case TwoFAAdmins:
		return role == "owner" || role == "admin"
	default:
		return false
	}
}

// TwoFAAllowed reports whether users may use 2FA at all.
func (c *Config) TwoFAAllowed() bool { return c.TwoFAMode != TwoFAOff }

// Load reads configuration from the environment. It returns non-fatal
// warnings separately so they can be logged at startup.
func Load() (*Config, []string, error) {
	var errs []error
	var warnings []string
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	c := &Config{
		Env:         getenv("REXUS_ENV", "production"),
		CompanyName: getenv("REXUS_COMPANY_NAME", "Rexus"),
		BaseURL:     strings.TrimRight(getenv("REXUS_BASE_URL", "http://localhost:8080"), "/"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		TwoFAMode:   strings.ToLower(getenv("REXUS_2FA_MODE", TwoFARequired)),
		BackupDir:   os.Getenv("REXUS_BACKUP_DIR"),
	}

	if c.Env != "production" && c.Env != "development" {
		fail("REXUS_ENV must be 'production' or 'development', got %q", c.Env)
	}
	if !strings.HasPrefix(c.BaseURL, "http://") && !strings.HasPrefix(c.BaseURL, "https://") {
		fail("REXUS_BASE_URL must start with http:// or https://, got %q", c.BaseURL)
	}

	port, err := strconv.Atoi(getenv("REXUS_PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		fail("REXUS_PORT must be a port number (1-65535)")
	}
	c.Port = port

	if c.DatabaseURL == "" {
		fail("DATABASE_URL is required (any Postgres connection string)")
	}

	if mk := os.Getenv("REXUS_MASTER_KEY"); mk == "" {
		fail("REXUS_MASTER_KEY is required — generate one with: rexus keygen")
	} else if key, err := crypto.ParseMasterKey(mk); err != nil {
		fail("REXUS_MASTER_KEY: %v", err)
	} else {
		c.MasterKey = key
	}

	switch c.TwoFAMode {
	case TwoFARequired, TwoFAAdmins, TwoFAOptional:
	case TwoFAOff:
		warnings = append(warnings, "REXUS_2FA_MODE=off — two-factor authentication is disabled for everyone")
	default:
		fail("REXUS_2FA_MODE must be one of required|admins|optional|off, got %q", c.TwoFAMode)
	}

	c.LoginOwnerOnly = parseBool("REXUS_LOGIN_OWNER_ONLY", false, fail)
	if c.LoginOwnerOnly {
		warnings = append(warnings, "REXUS_LOGIN_OWNER_ONLY=true — lockdown mode: only the owner can log in")
	}

	allow, err := parseAllowlist(os.Getenv("REXUS_IP_ALLOWLIST"))
	if err != nil {
		fail("REXUS_IP_ALLOWLIST: %v", err)
	}
	c.IPAllowlist = allow

	c.BackupEnabled = parseBool("REXUS_BACKUP_ENABLED", false, fail)
	if c.BackupEnabled && c.BackupDir == "" {
		fail("REXUS_BACKUP_DIR is required when REXUS_BACKUP_ENABLED=true")
	}

	c.ModuleScheduler = parseBool("REXUS_MODULE_SCHEDULER", true, fail)
	c.ModuleVault = parseBool("REXUS_MODULE_VAULT", true, fail)

	if len(errs) > 0 {
		return nil, warnings, fmt.Errorf("invalid configuration:\n  - %w", joinErrs(errs))
	}
	return c, warnings, nil
}

// Toggles returns the current toggle values for read-only display.
func (c *Config) Toggles() map[string]string {
	allow := "0.0.0.0 (allow all)"
	if c.IPAllowlist != nil {
		parts := make([]string, len(c.IPAllowlist))
		for i, p := range c.IPAllowlist {
			parts[i] = p.String()
		}
		allow = strings.Join(parts, ",")
	}
	return map[string]string{
		"REXUS_ENV":              c.Env,
		"REXUS_2FA_MODE":         c.TwoFAMode,
		"REXUS_LOGIN_OWNER_ONLY": strconv.FormatBool(c.LoginOwnerOnly),
		"REXUS_IP_ALLOWLIST":     allow,
		"REXUS_BACKUP_ENABLED":   strconv.FormatBool(c.BackupEnabled),
		"REXUS_MODULE_SCHEDULER": strconv.FormatBool(c.ModuleScheduler),
		"REXUS_MODULE_VAULT":     strconv.FormatBool(c.ModuleVault),
	}
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func parseBool(key string, def bool, fail func(string, ...any)) bool {
	v := strings.ToLower(getenv(key, ""))
	switch v {
	case "":
		return def
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		fail("%s must be true or false, got %q", key, v)
		return def
	}
}

// parseAllowlist parses a comma-separated list of IPs/CIDRs.
// Empty or "0.0.0.0" means allow all (returns nil).
func parseAllowlist(raw string) ([]netip.Prefix, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "0.0.0.0" || raw == "0.0.0.0/0" {
		return nil, nil
	}
	var out []netip.Prefix
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if part == "0.0.0.0" || part == "0.0.0.0/0" {
			return nil, nil
		}
		if strings.Contains(part, "/") {
			p, err := netip.ParsePrefix(part)
			if err != nil {
				return nil, fmt.Errorf("invalid CIDR %q", part)
			}
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(part)
		if err != nil {
			return nil, fmt.Errorf("invalid IP %q", part)
		}
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

func joinErrs(errs []error) error {
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = e.Error()
	}
	return errors.New(strings.Join(msgs, "\n  - "))
}
