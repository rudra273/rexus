package scheduler

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// Schedules are standard 5-field cron ("*/5 * * * *") or descriptors
// ("@hourly", "@daily", "@every 10m"). Prefix with "CRON_TZ=Asia/Kolkata "
// to pick a timezone; default is the server's timezone.
var parser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// MinInterval is the shortest allowed gap between runs.
const MinInterval = time.Minute

// Next returns the next run time after from.
func Next(schedule string, from time.Time) (time.Time, error) {
	s, err := parser.Parse(strings.TrimSpace(schedule))
	if err != nil {
		return time.Time{}, err
	}
	n := s.Next(from)
	if n.IsZero() {
		return time.Time{}, errors.New("schedule never runs")
	}
	return n, nil
}

// Validate checks that a schedule parses and doesn't run more often than
// MinInterval (so nobody accidentally hammers a site every second).
func Validate(schedule string) error {
	schedule = strings.TrimSpace(schedule)
	if schedule == "" {
		return errors.New("schedule is required")
	}
	s, err := parser.Parse(schedule)
	if err != nil {
		return fmt.Errorf("invalid schedule: %v", err)
	}
	t := time.Now()
	for i := 0; i < 5; i++ {
		n := s.Next(t)
		if n.IsZero() {
			return errors.New("schedule never runs")
		}
		if i > 0 && n.Sub(t) < MinInterval {
			return fmt.Errorf("schedule runs too often — minimum interval is %s", MinInterval)
		}
		t = n
	}
	return nil
}

// Preview returns the next n run times.
func Preview(schedule string, n int) ([]time.Time, error) {
	if err := Validate(schedule); err != nil {
		return nil, err
	}
	s, _ := parser.Parse(strings.TrimSpace(schedule))
	out := make([]time.Time, 0, n)
	t := time.Now()
	for i := 0; i < n; i++ {
		t = s.Next(t)
		out = append(out, t)
	}
	return out, nil
}

type statusRange struct{ lo, hi int }

// ParseExpectedStatus parses "200", "200-299" or "200,204,301-302".
func ParseExpectedStatus(spec string) ([]statusRange, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		spec = "200-299"
	}
	var out []statusRange
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lo, hi, isRange := strings.Cut(part, "-")
		a, err := strconv.Atoi(strings.TrimSpace(lo))
		if err != nil {
			return nil, fmt.Errorf("invalid status %q", part)
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(strings.TrimSpace(hi)); err != nil {
				return nil, fmt.Errorf("invalid status range %q", part)
			}
		}
		if a < 100 || b > 599 || a > b {
			return nil, fmt.Errorf("invalid status range %q (must be within 100-599)", part)
		}
		out = append(out, statusRange{a, b})
	}
	if len(out) == 0 {
		return nil, errors.New("expected status is empty")
	}
	return out, nil
}

func statusMatches(code int, ranges []statusRange) bool {
	for _, r := range ranges {
		if code >= r.lo && code <= r.hi {
			return true
		}
	}
	return false
}
