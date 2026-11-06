package appsettings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// fakeStore is an in-memory settings table. failSet makes writes fail.
type fakeStore struct {
	rows    map[string][]byte
	failSet bool
	sets    int
	deletes int
}

func newFake() *fakeStore { return &fakeStore{rows: map[string][]byte{}} }

func (f *fakeStore) GetSetting(_ context.Context, key string, dest any) (bool, error) {
	b, ok := f.rows[key]
	if !ok {
		return false, nil
	}
	return true, json.Unmarshal(b, dest)
}

func (f *fakeStore) SetSetting(_ context.Context, key string, value any) error {
	if f.failSet {
		return errors.New("database is down")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f.rows[key] = b
	f.sets++
	return nil
}

func (f *fakeStore) DeleteSetting(_ context.Context, key string) error {
	if f.failSet {
		return errors.New("database is down")
	}
	delete(f.rows, key)
	f.deletes++
	return nil
}

var defaults = Values{CompanyName: "Rexus", BaseURL: "http://localhost:8080"}

func str(s string) *string { return &s }

func TestStartsWithDefaults(t *testing.T) {
	s := New(newFake(), defaults)
	if s.Get() != defaults {
		t.Fatalf("got %+v, want the defaults", s.Get())
	}
	if err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.Get() != defaults {
		t.Fatalf("an empty database must leave the defaults, got %+v", s.Get())
	}
	src := s.Sources()
	if src["company_name"] != FromEnv || src["base_url"] != FromEnv {
		t.Fatalf("sources %+v, want both from env", src)
	}
}

func TestUpdateOverridesAndPersists(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	v, err := s.Update(ctx, Patch{CompanyName: str("  Rosmox  ")})
	if err != nil {
		t.Fatal(err)
	}
	if v.CompanyName != "Rosmox" || v.BaseURL != defaults.BaseURL {
		t.Fatalf("got %+v", v)
	}
	if s.Get() != v {
		t.Fatal("Get must return what Update returned")
	}
	if s.Sources()["company_name"] != FromUI || s.Sources()["base_url"] != FromEnv {
		t.Fatalf("sources %+v", s.Sources())
	}

	// a second Service on the same database (a restart) sees the saved value
	s2 := New(fake, defaults)
	if err := s2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s2.Get().CompanyName != "Rosmox" {
		t.Fatalf("saved value not loaded: %+v", s2.Get())
	}
}

func TestUpdateKeepsWhatIsNotInThePatch(t *testing.T) {
	ctx := context.Background()
	s := New(newFake(), defaults)
	if _, err := s.Update(ctx, Patch{BaseURL: str("https://cp.example.com")}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Update(ctx, Patch{CompanyName: str("Rosmox")})
	if err != nil {
		t.Fatal(err)
	}
	if v.BaseURL != "https://cp.example.com" || v.CompanyName != "Rosmox" {
		t.Fatalf("a patch must not undo other overrides: %+v", v)
	}
}

func TestEmptyStringClearsTheOverride(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	if _, err := s.Update(ctx, Patch{CompanyName: str("Rosmox"), BaseURL: str("https://cp.example.com")}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Update(ctx, Patch{CompanyName: str("")})
	if err != nil {
		t.Fatal(err)
	}
	if v.CompanyName != defaults.CompanyName || v.BaseURL != "https://cp.example.com" {
		t.Fatalf("got %+v", v)
	}
	// clearing the last override removes the row
	if _, err := s.Update(ctx, Patch{BaseURL: str("")}); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.rows[key]; ok {
		t.Fatal("with no overrides left the row should be deleted")
	}
	if s.Get() != defaults {
		t.Fatalf("got %+v, want the defaults", s.Get())
	}
}

func TestInvalidChangeChangesNothing(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	if _, err := s.Update(ctx, Patch{CompanyName: str("Rosmox")}); err != nil {
		t.Fatal(err)
	}
	before, sets := s.Get(), fake.sets
	// a valid name together with an invalid URL: neither may be applied
	if _, err := s.Update(ctx, Patch{CompanyName: str("Other"), BaseURL: str("ftp://nope")}); err == nil {
		t.Fatal("expected a validation error")
	}
	if s.Get() != before || fake.sets != sets {
		t.Fatalf("a rejected change must not apply or save anything: %+v, %d writes", s.Get(), fake.sets-sets)
	}
}

func TestStoreFailureChangesNothing(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	fake.failSet = true
	if _, err := s.Update(ctx, Patch{CompanyName: str("Rosmox")}); err == nil {
		t.Fatal("expected the database error")
	}
	if s.Get() != defaults || s.Sources()["company_name"] != FromEnv {
		t.Fatalf("a failed save must not change what is live: %+v %+v", s.Get(), s.Sources())
	}
}

func TestResetGoesBackToDefaults(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	if _, err := s.Update(ctx, Patch{CompanyName: str("Rosmox"), BaseURL: str("https://cp.example.com")}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Reset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if v != defaults || s.Get() != defaults {
		t.Fatalf("got %+v", v)
	}
	if len(fake.rows) != 0 {
		t.Fatal("reset must delete the saved row")
	}
}

func TestLoadIgnoresBadSavedValues(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	fake.rows[key] = []byte(`{"company_name":"   ","base_url":"javascript:alert(1)"}`)
	s := New(fake, defaults)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Get() != defaults {
		t.Fatalf("bad saved values must fall back to the defaults, got %+v", s.Get())
	}
	fake.rows[key] = []byte(`{"company_name":"Rosmox","base_url":"not a url"}`)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Get().CompanyName != "Rosmox" || s.Get().BaseURL != defaults.BaseURL {
		t.Fatalf("one good and one bad value: got %+v", s.Get())
	}
}

func TestLoadPicksUpAChangeMadeElsewhere(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, defaults)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	fake.rows[key] = []byte(`{"company_name":"From the CLI"}`) // another process wrote it
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Get().CompanyName != "From the CLI" {
		t.Fatalf("got %+v", s.Get())
	}
	delete(fake.rows, key) // and another process reset it
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Get() != defaults {
		t.Fatalf("got %+v, want the defaults after a reset elsewhere", s.Get())
	}
}

func TestValidateCompanyName(t *testing.T) {
	ok := map[string]string{"Rosmox": "Rosmox", "  Acme Inc.  ": "Acme Inc.", "Zoë & Co": "Zoë & Co", strings.Repeat("é", 80): strings.Repeat("é", 80)}
	for in, want := range ok {
		got, err := ValidateCompanyName(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", strings.Repeat("a", 81), "two\nlines", "tab\there", "bell\a"} {
		if _, err := ValidateCompanyName(in); err == nil {
			t.Errorf("%q should be rejected", in)
		}
	}
}

func TestValidateBaseURL(t *testing.T) {
	ok := map[string]string{
		"https://cp.rosmox.com":          "https://cp.rosmox.com",
		"https://cp.rosmox.com/":         "https://cp.rosmox.com",
		"  HTTPS://CP.Rosmox.com  ":      "https://cp.rosmox.com",
		"http://localhost:8080":          "http://localhost:8080",
		"http://192.168.0.10:8090/":      "http://192.168.0.10:8090",
		"https://rexus.example.com:8443": "https://rexus.example.com:8443",
	}
	for in, want := range ok {
		got, err := ValidateBaseURL(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{
		"", "cp.rosmox.com", "ftp://cp.rosmox.com", "javascript:alert(1)", "//cp.rosmox.com", "https://",
		"https://cp.rosmox.com/app", "https://cp.rosmox.com?x=1", "https://cp.rosmox.com#top",
		"https://user:pass@cp.rosmox.com", "https:// cp.rosmox.com", "https://" + strings.Repeat("a", 200) + ".com",
	}
	for _, in := range bad {
		if got, err := ValidateBaseURL(in); err == nil {
			t.Errorf("%q should be rejected, got %q", in, got)
		}
	}
}

func TestSecureCookiesFollowsTheURL(t *testing.T) {
	if !(Values{BaseURL: "https://x.com"}).SecureCookies() || (Values{BaseURL: "http://x.com"}).SecureCookies() {
		t.Fatal("secure cookies must follow the scheme of the public URL")
	}
}

func boolp(b bool) *bool { return &b }

// moduleDefaults is a typical .env: Vault and Scheduler on, backups off but a backup folder configured.
var moduleDefaults = Values{CompanyName: "Rexus", BaseURL: "http://localhost:8080", ModuleVault: true, ModuleScheduler: true, BackupEnabled: false, BackupDirSet: true}

func TestModuleSwitchesOverrideAndPersist(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	s := New(fake, moduleDefaults)
	v, err := s.Update(ctx, Patch{ModuleVault: boolp(false), BackupEnabled: boolp(true)})
	if err != nil {
		t.Fatal(err)
	}
	if v.ModuleVault || !v.ModuleScheduler || !v.BackupEnabled {
		t.Fatalf("got %+v, want vault off, scheduler left on, backups on", v)
	}
	src := s.Sources()
	if src["module_vault"] != FromUI || src["backup_enabled"] != FromUI || src["module_scheduler"] != FromEnv {
		t.Fatalf("sources %+v", src)
	}

	// a restart sees the saved switches; the .env defaults are still what "reset" returns to
	s2 := New(fake, moduleDefaults)
	if err := s2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s2.Get() != v {
		t.Fatalf("saved switches not loaded: %+v", s2.Get())
	}
}

func TestSwitchingOffIsSavedNotMistakenForUnset(t *testing.T) {
	// "false" must be stored as false, not dropped like a missing value (the zero value of a bool)
	ctx := context.Background()
	fake := newFake()
	s := New(fake, moduleDefaults)
	if _, err := s.Update(ctx, Patch{ModuleScheduler: boolp(false)}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fake.rows[key]), `"module_scheduler":false`) {
		t.Fatalf("an explicit false must be stored, got %s", fake.rows[key])
	}
	s2 := New(fake, moduleDefaults)
	if err := s2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s2.Get().ModuleScheduler {
		t.Fatal("scheduler should still be off after a reload")
	}
}

func TestResetModulesLeavesTheTextSettings(t *testing.T) {
	ctx := context.Background()
	s := New(newFake(), moduleDefaults)
	if _, err := s.Update(ctx, Patch{CompanyName: str("Rosmox"), ModuleVault: boolp(false), ModuleScheduler: boolp(false)}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Update(ctx, Patch{ResetModules: true})
	if err != nil {
		t.Fatal(err)
	}
	if !v.ModuleVault || !v.ModuleScheduler || v.CompanyName != "Rosmox" {
		t.Fatalf("got %+v, want the switches back to .env and the name kept", v)
	}
	if src := s.Sources(); src["module_vault"] != FromEnv || src["module_scheduler"] != FromEnv || src["company_name"] != FromUI {
		t.Fatalf("sources %+v", src)
	}
}

func TestResetModulesAndASwitchInOnePatch(t *testing.T) {
	// the reset is applied first, so a switch sent with it still takes effect
	ctx := context.Background()
	s := New(newFake(), moduleDefaults)
	if _, err := s.Update(ctx, Patch{ModuleVault: boolp(false), ModuleScheduler: boolp(false)}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Update(ctx, Patch{ResetModules: true, ModuleVault: boolp(false)})
	if err != nil {
		t.Fatal(err)
	}
	if v.ModuleVault || !v.ModuleScheduler {
		t.Fatalf("got %+v, want vault off (just set) and scheduler back on (reset)", v)
	}
}

func TestBackupsNeedAFolder(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	noDir := moduleDefaults
	noDir.BackupDirSet = false
	s := New(fake, noDir)

	_, err := s.Update(ctx, Patch{BackupEnabled: boolp(true)})
	var bad *InvalidError
	if !errors.As(err, &bad) || !strings.Contains(bad.Msg, "REXUS_BACKUP_DIR") {
		t.Fatalf("want an InvalidError that names REXUS_BACKUP_DIR, got %v", err)
	}
	if s.Get().BackupEnabled || fake.sets != 0 {
		t.Fatal("a refused change must not apply or save anything")
	}
	// turning backups off never needs a folder
	if _, err := s.Update(ctx, Patch{BackupEnabled: boolp(false)}); err != nil {
		t.Fatalf("switching backups off should always be allowed: %v", err)
	}
	// and with a folder, turning them on is fine
	if _, err := New(newFake(), moduleDefaults).Update(ctx, Patch{BackupEnabled: boolp(true)}); err != nil {
		t.Fatalf("with a folder, backups can be turned on: %v", err)
	}
}

func TestLoadIgnoresBackupsOnWhenTheFolderIsGone(t *testing.T) {
	// saved as "on", then REXUS_BACKUP_DIR was removed from .env: backups must not come up half-configured
	ctx := context.Background()
	fake := newFake()
	fake.rows[key] = []byte(`{"backup_enabled":true,"module_vault":false}`)
	noDir := moduleDefaults
	noDir.BackupDirSet = false
	s := New(fake, noDir)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Get().BackupEnabled {
		t.Fatal("backups can't be on without a folder")
	}
	if s.Get().ModuleVault {
		t.Fatal("the other saved switch should still apply")
	}
	if s.Sources()["backup_enabled"] != FromEnv {
		t.Fatal("the ignored value should report as coming from .env")
	}
}

func TestBackupDirSetIsNeverOverridden(t *testing.T) {
	ctx := context.Background()
	fake := newFake()
	fake.rows[key] = []byte(`{"BackupDirSet":false,"backup_dir_set":false}`)
	s := New(fake, moduleDefaults)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if !s.Get().BackupDirSet {
		t.Fatal("whether the backup folder exists comes from .env only")
	}
}
