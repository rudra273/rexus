package alerts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"rexus/internal/store"
)

// SummaryModules reflects the modules currently enabled for this instance.
type SummaryModules struct {
	Jobs, Vault, Backups bool
}

func checkStatus(c *store.HealthCheck, now time.Time) string {
	if c.LastCheckedAt == nil {
		return "waiting"
	}
	if now.Sub(*c.LastCheckedAt) > time.Duration(max(c.IntervalSeconds*3, 300))*time.Second {
		return "stale"
	}
	return c.Status
}

func (s *Service) statusSummary(ctx context.Context, now time.Time, modules SummaryModules) (Message, int, error) {
	checks, err := s.store.ListHealthChecks(ctx)
	if err != nil {
		return Message{}, 0, err
	}
	m := Message{Event: "telegram.status", Headline: "Rexus status", Severity: "ok", Link: s.base()}
	counts := map[string]int{}
	total, certificates := 0, 0
	var issues []string
	addIssue := func(text string) {
		if len(issues) < 5 {
			issues = append(issues, clip(text, 120))
		}
	}
	for _, c := range checks {
		if !c.Enabled {
			continue
		}
		total++
		status := checkStatus(c, now)
		counts[status]++
		if status != store.StatusUp {
			addIssue(fmt.Sprintf("%s / %s: %s", c.ProjectName, c.Name, status))
		}
		if c.SSLExpiresAt != nil && !c.SSLExpiresAt.After(now.AddDate(0, 0, 7)) {
			certificates++
		}
	}
	m.Lines = append(m.Lines, fmt.Sprintf("Checks: %d/%d up · %d down · %d degraded · %d stale · %d awaiting results",
		counts[store.StatusUp], total, counts[store.StatusDown], counts[store.StatusDegraded],
		counts["stale"], counts["waiting"]+counts[store.StatusUnknown]))
	switch {
	case counts[store.StatusDown] > 0:
		m.Severity = "critical"
	case counts[store.StatusUp] != total:
		m.Severity = "warning"
	case total == 0:
		m.Severity = "info"
	}

	if modules.Jobs {
		jobs, err := s.store.ListJobs(ctx, store.JobFilter{})
		if err != nil {
			return Message{}, 0, err
		}
		active, failed, waiting := 0, 0, 0
		for _, j := range jobs {
			if !j.Enabled {
				continue
			}
			active++
			switch deref(j.LastStatus) {
			case "failed":
				failed++
				addIssue(fmt.Sprintf("%s / %s: job failed", j.ProjectName, j.Name))
			case "":
				waiting++
			}
		}
		m.Lines = append(m.Lines, fmt.Sprintf("Jobs: %d active · %d failing · %d awaiting first result", active, failed, waiting))
		if failed > 0 {
			m.Severity = "critical"
		} else if waiting > 0 && m.Severity != "critical" {
			m.Severity = "warning"
		}
	}

	m.Lines = append(m.Lines, issues...)
	return m, certificates, nil
}

func (s *Service) digestSummary(ctx context.Context, now time.Time, modules SummaryModules) (Message, error) {
	m, certificates, err := s.statusSummary(ctx, now, modules)
	if err != nil {
		return Message{}, err
	}
	m.Event, m.Headline = "telegram.digest", "Rexus daily digest"

	const incidentLimit = 200
	events, err := s.store.ListRecentHealthEvents(ctx, store.Access{}, 24*time.Hour, incidentLimit)
	if err != nil {
		return Message{}, err
	}
	incidents := 0
	for _, event := range events {
		if event.ToStatus == store.StatusDown {
			incidents++
		}
	}
	if len(events) == incidentLimit {
		m.Lines = append(m.Lines, fmt.Sprintf("Outages in the last 24h: at least %d", incidents))
	} else {
		m.Lines = append(m.Lines, fmt.Sprintf("Outages in the last 24h: %d", incidents))
	}
	m.Lines = append(m.Lines, fmt.Sprintf("TLS: %d expired or expiring within 7 days", certificates))
	if modules.Vault {
		days := 7
		secrets, err := s.store.ListSecrets(ctx, store.SecretFilter{ExpiringDays: &days})
		if err != nil {
			return Message{}, err
		}
		count := fmt.Sprint(len(secrets))
		if len(secrets) == 500 {
			count += "+"
		}
		m.Lines = append(m.Lines, fmt.Sprintf("Vault: %s secrets expired or expiring within 7 days", count))
	}
	if modules.Backups {
		backup, err := s.store.LastBackupSuccess(ctx)
		switch {
		case errors.Is(err, store.ErrNotFound):
			m.Lines = append(m.Lines, "Backups: no successful backup recorded")
		case err != nil:
			return Message{}, err
		default:
			at := backup.StartedAt
			if backup.FinishedAt != nil {
				at = *backup.FinishedAt
			}
			m.Lines = append(m.Lines, "Last successful backup: "+fmtUTC(at))
		}
	}
	return m, nil
}
