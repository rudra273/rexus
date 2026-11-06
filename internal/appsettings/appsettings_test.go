package appsettings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
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

var defaults = Values{CompanyName: "Rexus", BaseURL: "http://localhost:8080", DateFormat: "system", SessionHours: 8}

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

// moduleDefaults: Vault, Scheduler and Backups all on, as they are out of the box.
var moduleDefaults = Values{CompanyName: "Rexus", BaseURL: "http://localhost:8080", ModuleVault: true, ModuleScheduler: true, BackupEnabled: true}

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

func ptr[T any](v T) *T { return &v }

// a 1x1 transparent PNG
const tinyPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

func TestLookAndSessionSettings(t *testing.T) {
	f := newFake()
	s := New(f, Values{CompanyName: "Acme", BaseURL: "https://x.test", DateFormat: "system", SessionHours: 8})
	if v := s.Get(); v.SessionTTL() != 8*time.Hour || v.Timezone != "" || v.AccentColor != "" || v.Logo != "" {
		t.Fatalf("defaults wrong: %+v", v)
	}
	v, err := s.Update(context.Background(), Patch{
		Timezone: ptr("Europe/London"), DateFormat: ptr("dmy"), AccentColor: ptr("#3B82F6"), Logo: ptr(tinyPNG), SessionHours: ptr(24),
	})
	if err != nil {
		t.Fatal(err)
	}
	if v.Timezone != "Europe/London" || v.DateFormat != "dmy" || v.AccentColor != "#3b82f6" || v.SessionTTL() != 24*time.Hour || v.LogoVersion == "" {
		t.Fatalf("not applied: %+v", v)
	}
	// survives a restart
	s2 := New(f, Values{DateFormat: "system", SessionHours: 8})
	if err := s2.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := s2.Get(); got.Timezone != "Europe/London" || got.SessionHours != 24 || got.Logo != tinyPNG {
		t.Fatalf("not persisted: %+v", got)
	}
	// clearing goes back to the defaults
	v, err = s.Update(context.Background(), Patch{Timezone: ptr(""), DateFormat: ptr(""), AccentColor: ptr(""), Logo: ptr(""), SessionHours: ptr(0)})
	if err != nil {
		t.Fatal(err)
	}
	if v.Timezone != "" || v.DateFormat != "system" || v.AccentColor != "" || v.Logo != "" || v.LogoVersion != "" || v.SessionHours != 8 {
		t.Fatalf("not cleared: %+v", v)
	}
	if len(f.rows) != 0 {
		t.Fatalf("expected the row to be deleted, have %v", f.rows)
	}
}

func TestLookAndSessionValidation(t *testing.T) {
	bad := []Patch{
		{Timezone: ptr("Mars/Olympus")},
		{Timezone: ptr("Local")},
		{DateFormat: ptr("klingon")},
		{AccentColor: ptr("red")},
		{AccentColor: ptr("#12345")},
		{SessionHours: ptr(-1)},
		{SessionHours: ptr(721)},
		{Logo: ptr("https://evil.test/x.png")},
		{Logo: ptr("data:text/html;base64,PGgxPmhpPC9oMT4=")},
		{Logo: ptr("data:image/png;base64,PGgxPmhpPC9oMT4=")}, // labelled PNG, really HTML
		{Logo: ptr("data:image/svg+xml;base64,aGVsbG8=")},     // labelled SVG, no <svg
		{Logo: ptr("data:image/png;base64,!!!")},
	}
	for i, p := range bad {
		s := New(newFake(), Values{})
		if _, err := s.Update(context.Background(), p); err == nil {
			t.Errorf("case %d should have been refused", i)
		} else if _, ok := err.(*InvalidError); !ok {
			t.Errorf("case %d: want InvalidError, got %T", i, err)
		}
	}
	svg := "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="
	if _, err := New(newFake(), Values{}).Update(context.Background(), Patch{Logo: ptr(svg)}); err != nil {
		t.Errorf("a real SVG should be accepted: %v", err)
	}
	big := "data:image/png;base64," + strings.Repeat("A", 400<<10)
	if _, err := New(newFake(), Values{}).Update(context.Background(), Patch{Logo: ptr(big)}); err == nil {
		t.Error("an oversized logo should be refused")
	}
}

func TestLoadIgnoresBadLookValues(t *testing.T) {
	f := newFake()
	f.rows[key] = []byte(`{"timezone":"Nope/Nope","accent_color":"blue","session_hours":99999,"logo":"data:text/html;base64,AAAA"}`)
	s := New(f, Values{DateFormat: "system", SessionHours: 8})
	if err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	v := s.Get()
	if v.Timezone != "" || v.AccentColor != "" || v.Logo != "" || v.SessionHours != 8 {
		t.Fatalf("bad saved values should be ignored: %+v", v)
	}
}
