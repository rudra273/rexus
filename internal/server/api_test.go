package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rexus/internal/store"
)

func TestBearerToken(t *testing.T) {
	long := "Bearer rxt_" + strings.Repeat("a", 120)
	cases := []struct {
		header          string
		wantPresent, ok bool
		wantToken       string
	}{
		{"Bearer rxt_abc123", true, true, "rxt_abc123"},
		{"bearer rxt_abc123", true, true, "rxt_abc123"},
		{"BEARER   rxt_abc123  ", true, true, "rxt_abc123"},
		{"Bearer notatoken", true, false, "notatoken"},
		{"Bearer sk_live_whatever", true, false, "sk_live_whatever"},
		{long, true, false, ""},
		{"Basic dXNlcjpwYXNz", false, false, ""},
		{"Bearer", false, false, ""},
		{"Bearer ", false, false, ""},
		{"Bearerrxt_abc", false, false, ""},
		{"", false, false, ""},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/api/v1/health", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		tok, present, ok := bearerToken(r)
		if present != c.wantPresent || ok != c.ok {
			t.Errorf("%q: present=%v ok=%v, want present=%v ok=%v", c.header, present, ok, c.wantPresent, c.ok)
		}
		if c.wantToken != "" && tok != c.wantToken {
			t.Errorf("%q: token %q, want %q", c.header, tok, c.wantToken)
		}
	}
}

func TestNewTokenShape(t *testing.T) {
	a, prefixA := newToken()
	b, _ := newToken()
	if !strings.HasPrefix(a, "rxt_") || len(a) != len("rxt_")+43 {
		t.Fatalf("token should be rxt_ + 43 chars (256 bits), got %q (%d)", a, len(a))
	}
	if prefixA != a[:8] {
		t.Fatalf("the UI prefix must be the first 8 characters, got %q", prefixA)
	}
	if a == b {
		t.Fatal("tokens must be unique")
	}
	if _, present, ok := bearerToken(reqWithAuth("Bearer " + a)); !present || !ok {
		t.Fatal("a generated token must pass its own shape check")
	}
}

func reqWithAuth(h string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", h)
	return r
}

func TestRateLimiter(t *testing.T) {
	l := newRateLimiter(3, time.Minute)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	for i, wantRemaining := range []int{2, 1, 0} {
		ok, remaining, _ := l.Allow("tokenA", now)
		if !ok || remaining != wantRemaining {
			t.Fatalf("request %d: ok=%v remaining=%d, want remaining %d", i+1, ok, remaining, wantRemaining)
		}
	}
	ok, remaining, reset := l.Allow("tokenA", now.Add(10*time.Second))
	if ok || remaining != 0 {
		t.Fatalf("4th request in the window must be refused, got ok=%v remaining=%d", ok, remaining)
	}
	if reset != 50*time.Second {
		t.Errorf("reset should be the time left in the window, got %v", reset)
	}
	if ok, _, _ := l.Allow("tokenB", now); !ok {
		t.Error("another token has its own allowance")
	}
	if ok, _, _ := l.Allow("tokenA", now.Add(61*time.Second)); !ok {
		t.Error("a new window starts after a minute")
	}
}

func TestRedactURL(t *testing.T) {
	cases := map[string]string{
		"https://acme.com/health":                         "https://acme.com/health",
		"https://acme.com/health?token=SECRET&x=1":        "https://acme.com/health",
		"https://user:pass@acme.com/health?apikey=SECRET": "https://acme.com/health",
		"https://acme.com/a#frag":                         "https://acme.com/a",
		"http://127.0.0.1:8090/api/health":                "http://127.0.0.1:8090/api/health",
		"://bad":                                          "",
	}
	for in, want := range cases {
		if got := redactURL(in); got != want {
			t.Errorf("redactURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSecretMetadataVisibleToTokens(t *testing.T) {
	days := 5
	exp := "2026-11-10"
	sec := &store.Secret{
		ID: "s1", ProjectKey: "shop", EnvironmentName: "prod", Name: "STRIPE_KEY", Tags: []string{"payment"},
		ExpiresOn: &exp, DaysLeft: &days, CurrentVersion: 3, Notes: "rotate via the dashboard",
		CustomFields: map[string]string{"owner": "Rudra"},
	}
	viewer := toSecretV1(sec, &store.APIToken{Role: "viewer"})
	b, _ := json.Marshal(viewer)
	for _, hidden := range []string{"notes", "custom_fields", "rotate via", "Rudra", "value"} {
		if strings.Contains(string(b), hidden) {
			t.Errorf("a viewer token must not see %q: %s", hidden, b)
		}
	}
	for _, shown := range []string{"STRIPE_KEY", "prod", "2026-11-10", `"days_left":5`, `"version":3`} {
		if !strings.Contains(string(b), shown) {
			t.Errorf("a viewer token should see %q: %s", shown, b)
		}
	}
	contrib := toSecretV1(sec, &store.APIToken{Role: "contributor"})
	b, _ = json.Marshal(contrib)
	if !strings.Contains(string(b), "rotate via the dashboard") || !strings.Contains(string(b), "Rudra") {
		t.Errorf("a contributor token sees notes and custom fields: %s", b)
	}
	if strings.Contains(string(b), `"value"`) {
		t.Error("the secret's value is only ever returned by the reveal endpoint")
	}
}

func TestCheckAndJobViewsLeakNothing(t *testing.T) {
	c := toCheckV1(&store.HealthCheck{ID: "c1", Name: "Site", URL: "https://user:pw@acme.com/health?token=SECRET", Method: "GET"})
	b, _ := json.Marshal(c)
	for _, leak := range []string{"SECRET", "user:pw", "token="} {
		if strings.Contains(string(b), leak) {
			t.Errorf("a monitored URL must be redacted, found %q in %s", leak, b)
		}
	}
	st := "failed"
	j := toJobV1(&store.Job{ID: "j1", Name: "Keepalive", Schedule: "@hourly", Enabled: true, LastStatus: &st,
		Config: store.HTTPConfig{URL: "https://x.supabase.co?apikey=SECRET", Method: "POST", Body: `{"password":"hunter2"}`}})
	b, _ = json.Marshal(j)
	for _, leak := range []string{"SECRET", "hunter2", "supabase", "password", `"url"`, `"body"`, `"config"`} {
		if strings.Contains(string(b), leak) {
			t.Errorf("a job's URL and body must never be exposed, found %q in %s", leak, b)
		}
	}
}

func TestAggregateStatus(t *testing.T) {
	c := func(status string, enabled bool) *store.HealthCheck {
		return &store.HealthCheck{Status: status, Enabled: enabled}
	}
	cases := []struct {
		checks []*store.HealthCheck
		want   string
	}{
		{nil, "none"},
		{[]*store.HealthCheck{c("down", false)}, "none"}, // paused checks don't count
		{[]*store.HealthCheck{c("unknown", true)}, "unknown"},
		{[]*store.HealthCheck{c("unknown", true), c("up", true)}, "up"},
		{[]*store.HealthCheck{c("up", true), c("degraded", true)}, "degraded"},
		{[]*store.HealthCheck{c("degraded", true), c("down", true), c("up", true)}, "down"},
		{[]*store.HealthCheck{c("up", true), c("down", false)}, "up"},
	}
	for i, tc := range cases {
		if got := aggregateStatus(tc.checks); got != tc.want {
			t.Errorf("case %d: got %q, want %q", i, got, tc.want)
		}
	}
}

func TestRenderDotenv(t *testing.T) {
	got := renderDotenv(map[string]string{
		"B_KEY":    `plain`,
		"A_KEY":    `with "quotes" and $HOME and # hash\ and spaces`,
		"C_PEM":    "-----BEGIN KEY-----\nabc\r\n-----END KEY-----",
		"D_APOS":   `it's fine`,
		"E_HARD":   "it's \"hard\"\nand $x",
		"bad-name": "x",
	})
	want := "A_KEY='with \"quotes\" and $HOME and # hash\\ and spaces'\n" +
		"B_KEY='plain'\n" +
		"C_PEM=\"-----BEGIN KEY-----\\nabc\\r\\n-----END KEY-----\"\n" +
		"D_APOS=\"it's fine\"\n" +
		"E_HARD=\"it's \\\"hard\\\"\\nand \\$x\"\n" +
		"# skipped \"bad-name\": not a valid variable name\n"
	if got != want {
		t.Fatalf("dotenv output:\n got %q\nwant %q", got, want)
	}
	if renderDotenv(map[string]string{}) != "" {
		t.Fatal("an empty scope must produce an empty file")
	}
}
