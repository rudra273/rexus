package scheduler

import (
	"testing"
	"time"

	"rexus/internal/store"
)

func ip(n int) *int { return &n }

var now = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

func okOutcome(ms int) Outcome    { return Outcome{OK: true, StatusCode: 200, ResponseMS: ms} }
func badOutcome(e string) Outcome { return Outcome{Err: e} }

// run feeds a sequence of outcomes through Evaluate and returns the statuses.
func run(c Current, outcomes ...Outcome) []string {
	var got []string
	for _, o := range outcomes {
		t := Evaluate(c, o, now)
		c.Status, c.Failures, c.Successes = t.Status, t.Failures, t.Successes
		got = append(got, t.Status)
	}
	return got
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestFirstSuccessIsUp(t *testing.T) {
	got := run(Current{Status: "unknown", DownThreshold: 3, RecoveryThreshold: 1}, okOutcome(50))
	if !eq(got, []string{"up"}) {
		t.Fatalf("got %v", got)
	}
}

func TestDownOnlyAfterThresholdFailuresInARow(t *testing.T) {
	c := Current{Status: "up", DownThreshold: 3, RecoveryThreshold: 1}
	got := run(c, badOutcome("timeout"), badOutcome("timeout"), badOutcome("timeout"))
	if !eq(got, []string{"up", "up", "down"}) {
		t.Fatalf("got %v", got)
	}
}

func TestBlipResetsFailureCount(t *testing.T) {
	c := Current{Status: "up", DownThreshold: 3, RecoveryThreshold: 1}
	got := run(c, badOutcome("x"), badOutcome("x"), okOutcome(10), badOutcome("x"), badOutcome("x"))
	if !eq(got, []string{"up", "up", "up", "up", "up"}) {
		t.Fatalf("a success in between must reset the count, got %v", got)
	}
}

func TestThresholdOneIsImmediate(t *testing.T) {
	got := run(Current{Status: "up", DownThreshold: 1, RecoveryThreshold: 1}, badOutcome("503"))
	if !eq(got, []string{"down"}) {
		t.Fatalf("got %v", got)
	}
}

func TestRecoveryThreshold(t *testing.T) {
	c := Current{Status: "down", Failures: 5, DownThreshold: 3, RecoveryThreshold: 3}
	got := run(c, okOutcome(10), okOutcome(10), badOutcome("x"), okOutcome(10), okOutcome(10), okOutcome(10))
	want := []string{"down", "down", "down", "down", "down", "up"}
	if !eq(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestFirstFailuresStayUnknownUntilThreshold(t *testing.T) {
	c := Current{Status: "unknown", DownThreshold: 2, RecoveryThreshold: 1}
	got := run(c, badOutcome("x"), badOutcome("x"))
	if !eq(got, []string{"unknown", "down"}) {
		t.Fatalf("got %v", got)
	}
}

func TestSlowResponseIsDegraded(t *testing.T) {
	c := Current{Status: "up", DownThreshold: 3, RecoveryThreshold: 1, MaxResponseMS: ip(500)}
	got := run(c, okOutcome(900), okOutcome(100))
	if !eq(got, []string{"degraded", "up"}) {
		t.Fatalf("got %v", got)
	}
	// No limit configured: never degraded for slowness.
	c.MaxResponseMS = nil
	if got := run(c, okOutcome(99999)); !eq(got, []string{"up"}) {
		t.Fatalf("got %v", got)
	}
}

func TestSSLExpiringIsDegraded(t *testing.T) {
	c := Current{Status: "up", DownThreshold: 3, RecoveryThreshold: 1, SSLWarnDays: ip(14)}
	soon := now.Add(5 * 24 * time.Hour)
	later := now.Add(90 * 24 * time.Hour)

	o := okOutcome(10)
	o.SSLExpiresAt = &soon
	tr := Evaluate(c, o, now)
	if tr.Status != "degraded" || tr.Message != "SSL certificate expires in 5 days" {
		t.Fatalf("got %+v", tr)
	}
	o.SSLExpiresAt = &later
	if tr := Evaluate(c, o, now); tr.Status != "up" {
		t.Fatalf("got %+v", tr)
	}
	// Warning disabled: an expiring cert doesn't matter.
	c.SSLWarnDays = nil
	o.SSLExpiresAt = &soon
	if tr := Evaluate(c, o, now); tr.Status != "up" {
		t.Fatalf("got %+v", tr)
	}
}

func TestDegradedCanGoDown(t *testing.T) {
	c := Current{Status: "degraded", DownThreshold: 2, RecoveryThreshold: 1}
	got := run(c, badOutcome("x"), badOutcome("x"))
	if !eq(got, []string{"degraded", "down"}) {
		t.Fatalf("got %v", got)
	}
}

func TestMessages(t *testing.T) {
	down := Evaluate(Current{Status: "up", Failures: 2, DownThreshold: 3, RecoveryThreshold: 1}, badOutcome("connection refused"), now)
	if down.Status != store.StatusDown || down.Message != "connection refused (3 failed checks in a row)" {
		t.Fatalf("got %+v", down)
	}
	rec := Evaluate(Current{Status: "down", DownThreshold: 3, RecoveryThreshold: 1}, okOutcome(120), now)
	if rec.Status != store.StatusUp || rec.Message != "recovered (HTTP 200, 120 ms)" {
		t.Fatalf("got %+v", rec)
	}
	// No change → no message.
	if same := Evaluate(Current{Status: "up", DownThreshold: 3, RecoveryThreshold: 1}, okOutcome(10), now); same.Message != "" {
		t.Fatalf("unexpected message %q", same.Message)
	}
}
