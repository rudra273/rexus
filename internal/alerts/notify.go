package alerts

import (
	"fmt"
	"time"

	"rexus/internal/store"
)

// This file builds the message for each event. Every message names the
// project and links back into Rexus.

func projectLine(name, key string) string { return fmt.Sprintf("%s (%s)", name, key) }

// CheckChanged turns a health status change into an alert.
//
//   - → down: "check.down" (only after the check's own failure threshold)
//   - down → up/degraded: "check.recovered"
//   - up → degraded because of slowness: "check.degraded"
//
// A degraded status caused by an expiring SSL certificate sends nothing here —
// the certificate reminders cover it.
func (s *Service) CheckChanged(ch *store.HealthChange) {
	c := ch.Check
	if c == nil {
		return
	}
	checkLine := fmt.Sprintf("Check: %s — %s %s", c.Name, c.Method, c.URL)
	base := Message{ProjectKey: c.ProjectKey, Link: s.Link("/checks/" + c.ID)}
	proj := projectLine(c.ProjectName, c.ProjectKey)

	switch {
	case ch.To == store.StatusDown:
		m := base
		m.Event, m.Severity = EventCheckDown, "critical"
		m.Headline = "DOWN — " + proj
		m.Lines = []string{checkLine, "Reason: " + ch.Message, "Since: " + fmtUTC(time.Now())}
		s.Notify(m)

	case ch.From == store.StatusDown:
		m := base
		m.Event, m.Severity = EventCheckRecovered, "ok"
		m.Headline = "RECOVERED — " + proj
		m.Lines = []string{checkLine}
		if ch.Since != nil {
			m.Lines = append(m.Lines, "Was down for "+humanDuration(time.Since(*ch.Since)))
		}
		m.Lines = append(m.Lines, "Now: "+ch.Message)
		s.Notify(m)

	case ch.To == store.StatusDegraded && ch.Reason == "slow":
		m := base
		m.Event, m.Severity = EventCheckDegraded, "warning"
		m.Headline = "SLOW — " + proj
		m.Lines = []string{checkLine, ch.Message}
		s.Notify(m)
	}
}

// JobFailed alerts when a cron job starts failing (the caller only calls this
// on the change from working to failed, so a job that keeps failing doesn't
// repeat the alert).
func (s *Service) JobFailed(j *store.Job, run *store.JobRun) {
	m := Message{Event: EventJobFailed, Severity: "critical", Link: s.Link("/jobs/" + j.ID)}
	if j.ProjectKey != nil && j.ProjectName != nil {
		m.ProjectKey = *j.ProjectKey
		m.Headline = "JOB FAILED — " + projectLine(*j.ProjectName, *j.ProjectKey)
	} else {
		m.Headline = "JOB FAILED — " + j.Name
	}
	m.Lines = []string{fmt.Sprintf("Job: %s — %s %s", j.Name, j.Config.Method, j.Config.URL)}
	if run.Error != nil {
		m.Lines = append(m.Lines, "Error: "+*run.Error)
	}
	m.Lines = append(m.Lines, fmt.Sprintf("Attempts: %d", run.Attempts), "When: "+fmtUTC(time.Now()))
	s.Notify(m)
}

// NewDeviceLogin alerts that someone logged in from an IP/browser not seen before.
func (s *Service) NewDeviceLogin(u *store.User, ip, userAgent string) {
	s.Notify(Message{
		Event:    EventNewDevice,
		Severity: "info",
		Headline: "NEW LOGIN — " + u.Email,
		Lines:    []string{"Role: " + u.Role, "IP address: " + ip, "Browser: " + clip(userAgent, 120), "When: " + fmtUTC(time.Now())},
		Link:     s.Link("/audit"),
	})
}

// ---- expiry reminders ----

// Bucket picks which reminder a number of days-left falls into: the
// tightest threshold it has reached ("30", "7", "1"), or "expired". ok is
// false while it is still outside every threshold. thresholds are ascending
// or descending — order doesn't matter.
func Bucket(daysLeft int, thresholds []int) (string, bool) {
	if daysLeft < 0 {
		return "expired", true
	}
	best, found := 0, false
	for _, t := range thresholds {
		if daysLeft <= t && (!found || t < best) {
			best, found = t, true
		}
	}
	if !found {
		return "", false
	}
	return fmt.Sprint(best), true
}

func normalizeDays(days []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, d := range days {
		if d >= 1 && d <= 365 && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	// largest first
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j] > out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func expiryText(days int) string {
	switch {
	case days < 0:
		return fmt.Sprintf("expired %d %s ago", -days, plural(-days, "day", "days"))
	case days == 0:
		return "expires today"
	}
	return fmt.Sprintf("expires in %d %s", days, plural(days, "day", "days"))
}

func expirySeverity(days int) string {
	if days <= 7 {
		return "critical"
	}
	return "warning"
}

// sslThresholds: the check's own warning window, then 7 and 1 days.
func sslThresholds(warnDays int) []int {
	out := []int{warnDays}
	for _, t := range []int{7, 1} {
		if t < warnDays {
			out = append(out, t)
		}
	}
	return out
}

func daysUntil(t time.Time) int {
	return int(time.Until(t).Hours() / 24) // truncates toward zero; callers treat < 0 as expired
}

func dateOnly(t time.Time) string { return t.UTC().Format("2006-01-02") }
