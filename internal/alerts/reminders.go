package alerts

import (
	"context"
	"fmt"
	"time"

	"rexus/internal/store"
)

const (
	reminderStartDelay = 20 * time.Second
	reminderInterval   = time.Hour
)

// Start runs the expiry reminders (secrets and SSL certificates) shortly
// after boot and then every hour, until ctx is cancelled. Each reminder goes
// to each channel once, so restarts and the hourly loop never repeat it.
func (s *Service) Start(ctx context.Context, modules func() SummaryModules) {
	s.startTelegram(ctx, modules)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		timer := time.NewTimer(reminderStartDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				s.RunReminders(ctx)
				timer.Reset(reminderInterval)
			}
		}
	}()
}

// RunReminders checks every expiry date once. Safe to call repeatedly.
func (s *Service) RunReminders(ctx context.Context) {
	s.secretReminders(ctx)
	s.sslReminders(ctx)
}

func (s *Service) secretReminders(ctx context.Context) {
	if !s.eventEnabled(ctx, EventSecretExpiring) {
		return
	}
	days := s.ReminderDays(ctx)
	widest := days[0]
	secrets, err := s.store.ListSecrets(ctx, store.SecretFilter{ExpiringDays: &widest})
	if err != nil {
		s.log.Error("alerts: list expiring secrets", "err", err)
		return
	}
	for _, sec := range secrets {
		if sec.DaysLeft == nil || sec.ExpiresOn == nil {
			continue
		}
		bucket, ok := Bucket(*sec.DaysLeft, days)
		if !ok {
			continue
		}
		s.NotifySync(ctx, Message{
			Event:      EventSecretExpiring,
			Severity:   expirySeverity(*sec.DaysLeft),
			Headline:   "KEY EXPIRING — " + scopedLine(sec.ProjectName, sec.ProjectKey, sec.ServiceKey),
			Lines:      []string{fmt.Sprintf("Secret: %s (%s)", sec.Name, sec.EnvironmentName), fmt.Sprintf("Expires: %s — %s", *sec.ExpiresOn, expiryText(*sec.DaysLeft))},
			Link:       s.Link("/projects/" + sec.ProjectKey),
			ProjectKey: sec.ProjectKey,
			ServiceKey: deref(sec.ServiceKey),
			// A new expiry date (the key was rotated) starts fresh.
			DedupeKey: fmt.Sprintf("secret:%s:%s:%s", sec.ID, *sec.ExpiresOn, bucket),
		})
	}
}

func (s *Service) sslReminders(ctx context.Context) {
	if !s.eventEnabled(ctx, EventSSLExpiring) {
		return
	}
	checks, err := s.store.ListHealthChecks(ctx)
	if err != nil {
		s.log.Error("alerts: list health checks", "err", err)
		return
	}
	for _, c := range checks {
		if !c.Enabled || c.SSLWarnDays == nil || c.SSLExpiresAt == nil {
			continue
		}
		left := daysUntil(*c.SSLExpiresAt)
		if time.Until(*c.SSLExpiresAt) < 0 && left == 0 {
			left = -1
		}
		bucket, ok := Bucket(left, sslThresholds(*c.SSLWarnDays))
		if !ok {
			continue
		}
		s.NotifySync(ctx, Message{
			Event:    EventSSLExpiring,
			Severity: expirySeverity(left),
			Headline: "SSL EXPIRING — " + scopedLine(c.ProjectName, c.ProjectKey, c.ServiceKey),
			Lines: []string{
				fmt.Sprintf("Check: %s — %s", c.Name, c.URL),
				fmt.Sprintf("Certificate expires %s — %s", dateOnly(*c.SSLExpiresAt), expiryText(left)),
			},
			Link:       s.Link("/checks/" + c.ID),
			ProjectKey: c.ProjectKey,
			ServiceKey: deref(c.ServiceKey),
			DedupeKey:  fmt.Sprintf("ssl:%s:%s:%s", c.ID, dateOnly(*c.SSLExpiresAt), bucket),
		})
	}
}

// ---- invite and reset emails ----

// SendInvite emails an invite link (when SMTP is configured).
func (s *Service) SendInvite(ctx context.Context, to, link, role, invitedBy string) error {
	body := fmt.Sprintf("%s invited you to %s on Rexus as %s.\n\nSet your password and finish signing up here:\n%s\n\nThe link works once and expires in 7 days.\n", invitedBy, s.name(), role, link)
	return s.SendEmail(ctx, to, "You're invited to "+s.name()+" on Rexus", body)
}

// SendPasswordReset emails a password-reset link.
func (s *Service) SendPasswordReset(ctx context.Context, to, link, byAdmin string) error {
	body := fmt.Sprintf("%s created a password-reset link for your %s account on Rexus:\n%s\n\nThe link works once and expires in 24 hours. If you didn't expect this, tell your administrator.\n", byAdmin, s.name(), link)
	return s.SendEmail(ctx, to, "Reset your Rexus password", body)
}
