package scheduler

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"rexus/internal/store"
)

const (
	healthUserAgent  = "Rexus-Health/1.0"
	healthRetention  = 30 * 24 * time.Hour
	healthBatchLimit = 20
)

// Outcome is what one probe observed.
type Outcome struct {
	OK           bool
	StatusCode   int // 0 = no response
	ResponseMS   int
	Err          string
	SSLExpiresAt *time.Time
}

// Current is the part of a check's state and settings that decides its next status.
type Current struct {
	Status            string
	Failures          int
	Successes         int
	DownThreshold     int
	RecoveryThreshold int
	MaxResponseMS     *int
	SSLWarnDays       *int
}

// Evaluate is the status state machine (plan.md §7.1):
//
//   - A failed probe counts toward the down threshold; the check only becomes
//     DOWN after that many failures in a row, so one blip doesn't flip it.
//   - A DOWN check only recovers after the recovery threshold of successes in a row.
//   - A successful probe is UP, or DEGRADED when it was slow or the SSL
//     certificate is close to expiring.
func Evaluate(c Current, o Outcome, now time.Time) store.HealthTransition {
	t := store.HealthTransition{Status: c.Status, Failures: c.Failures, Successes: c.Successes}

	if !o.OK {
		t.Failures++
		t.Successes = 0
		if t.Failures >= c.DownThreshold {
			t.Status = store.StatusDown
		}
		if t.Status != c.Status {
			t.Message = fmt.Sprintf("%s (%d failed check%s in a row)", o.Err, t.Failures, plural(t.Failures))
		}
		return t
	}

	t.Failures = 0
	t.Successes++
	if c.Status == store.StatusDown && t.Successes < c.RecoveryThreshold {
		return t // still down until enough consecutive successes
	}

	reason := ""
	switch {
	case c.MaxResponseMS != nil && o.ResponseMS > *c.MaxResponseMS:
		reason = fmt.Sprintf("slow response: %d ms (limit %d ms)", o.ResponseMS, *c.MaxResponseMS)
		t.Reason = "slow"
	case c.SSLWarnDays != nil && o.SSLExpiresAt != nil && o.SSLExpiresAt.Sub(now) < time.Duration(*c.SSLWarnDays)*24*time.Hour:
		days := int(o.SSLExpiresAt.Sub(now).Hours() / 24)
		reason = fmt.Sprintf("SSL certificate expires in %d day%s", days, plural(days))
		t.Reason = "ssl"
	}
	if reason != "" {
		t.Status = store.StatusDegraded
	} else {
		t.Status = store.StatusUp
	}
	if t.Status != c.Status {
		switch {
		case c.Status == store.StatusDown:
			t.Message = fmt.Sprintf("recovered (HTTP %d, %d ms)", o.StatusCode, o.ResponseMS)
		case reason != "":
			t.Message = reason
		default:
			t.Message = "back to normal"
		}
	}
	return t
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// ---- engine side ----

func (e *Engine) tickHealth(ctx context.Context) {
	checks, err := e.store.ClaimDueChecks(ctx, healthBatchLimit)
	if err != nil {
		if ctx.Err() == nil {
			e.log.Error("health: claim due checks", "err", err)
		}
		return
	}
	for _, c := range checks {
		e.launchCheck(c)
	}
}

// CheckNow probes a check immediately (the "Run now" button).
func (e *Engine) CheckNow(c *store.HealthCheck) { e.launchCheck(c) }

func (e *Engine) launchCheck(c *store.HealthCheck) {
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		e.sem <- struct{}{}
		defer func() { <-e.sem }()
		e.runCheck(context.Background(), c)
	}()
}

func (e *Engine) runCheck(ctx context.Context, c *store.HealthCheck) {
	o := e.probe(ctx, c)

	res := store.HealthResult{OK: o.OK, SSLExpiresAt: o.SSLExpiresAt}
	if o.StatusCode != 0 {
		res.StatusCode = &o.StatusCode
	}
	if o.OK || o.StatusCode != 0 {
		res.ResponseMS = &o.ResponseMS
	}
	if o.Err != "" {
		res.Error = &o.Err
	}

	change, err := e.store.RecordHealth(ctx, c.ID, res, func(cur *store.HealthCheck) store.HealthTransition {
		// Use the freshly locked row's settings, not the copy claimed earlier.
		return Evaluate(Current{
			Status:            cur.Status,
			Failures:          cur.ConsecutiveFailures,
			Successes:         cur.ConsecutiveSuccesses,
			DownThreshold:     cur.DownThreshold,
			RecoveryThreshold: cur.RecoveryThreshold,
			MaxResponseMS:     cur.MaxResponseMS,
			SSLWarnDays:       cur.SSLWarnDays,
		}, o, time.Now())
	})
	if errors.Is(err, store.ErrNotFound) {
		return // deleted while the probe was running
	}
	if err != nil {
		e.log.Error("health: record result", "check", c.ID, "err", err)
		return
	}
	if change != nil {
		e.log.Info("health status changed", "check", c.Name, "project", c.ProjectKey, "from", change.From, "to", change.To)
		e.alerts.CheckChanged(change)
	}
}

// probe performs one HTTP request. A 3xx is followed like a browser would.
func (e *Engine) probe(ctx context.Context, c *store.HealthCheck) Outcome {
	ranges, err := ParseExpectedStatus(c.ExpectedStatus)
	if err != nil {
		return Outcome{Err: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeoutSeconds)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, c.Method, c.URL, nil)
	if err != nil {
		return Outcome{Err: err.Error()}
	}
	req.Header.Set("User-Agent", healthUserAgent)

	start := time.Now()
	resp, err := e.client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return Outcome{Err: fmt.Sprintf("timeout after %ds", c.TimeoutSeconds)}
		}
		return Outcome{Err: cleanErr(err)}
	}
	defer resp.Body.Close()
	ms := int(time.Since(start).Milliseconds()) // time until the response headers arrived
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))

	o := Outcome{StatusCode: resp.StatusCode, ResponseMS: ms, SSLExpiresAt: certExpiry(resp.TLS)}
	if statusMatches(resp.StatusCode, ranges) {
		o.OK = true
	} else {
		o.Err = fmt.Sprintf("unexpected status %d (expected %s)", resp.StatusCode, c.ExpectedStatus)
	}
	return o
}

// certExpiry returns when the server's own (leaf) certificate expires.
func certExpiry(cs *tls.ConnectionState) *time.Time {
	if cs == nil || len(cs.PeerCertificates) == 0 {
		return nil
	}
	t := cs.PeerCertificates[0].NotAfter
	return &t
}

// cleanErr drops the noisy `Get "https://…":` prefix Go adds to request errors.
func cleanErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err.Error()
	}
	return err.Error()
}
