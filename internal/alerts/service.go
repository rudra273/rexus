package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"rexus/internal/crypto"
	"rexus/internal/store"
)

// configAAD binds an encrypted channel config to its purpose.
var configAAD = []byte("rexus:alert-channel")

// maxAttempts caps how often a reminder is re-tried on a channel that keeps failing.
const maxAttempts = 3

type Service struct {
	store   *store.Store
	keys    *crypto.Keyring
	log     *slog.Logger
	baseURL string
	company string
	smtp    SMTPConfig
	mailer  *Mailer
	sender  *Sender
	wg      sync.WaitGroup
}

func New(st *store.Store, keys *crypto.Keyring, log *slog.Logger, baseURL, company string, smtp SMTPConfig) *Service {
	m := &Mailer{cfg: smtp}
	return &Service{store: st, keys: keys, log: log, baseURL: baseURL, company: company, smtp: smtp, mailer: m, sender: newSender(m)}
}

func (s *Service) SMTPConfigured() bool { return s.smtp.Configured() }
func (s *Service) SMTPHost() string     { return s.smtp.Host }

// Link builds an absolute link into the Rexus UI.
func (s *Service) Link(path string) string { return s.baseURL + path }

// Wait blocks until in-flight alerts have been delivered (or the timeout passes).
func (s *Service) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		s.log.Warn("alerts: shutdown timed out with deliveries still in progress")
	}
}

// ---- channel configs ----

func (s *Service) EncryptConfig(c *Config) ([]byte, error) {
	raw, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	return s.keys.Encrypt(raw, configAAD)
}

func (s *Service) DecryptConfig(blob []byte) (*Config, error) {
	raw, err := s.keys.Decrypt(blob, configAAD)
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(raw, c); err != nil {
		return nil, err
	}
	return c, nil
}

// ---- settings ----

func (s *Service) eventEnabled(ctx context.Context, key string) bool {
	def, ok := EventByKey(key)
	if !ok {
		return false
	}
	settings, err := s.store.AlertEventSettings(ctx)
	if err != nil {
		s.log.Error("alerts: read event settings", "err", err)
		return def.DefaultEnabled
	}
	if st, ok := settings[key]; ok {
		return st.Enabled
	}
	return def.DefaultEnabled
}

// ReminderDays returns the configured key-expiry reminder days, largest first.
func (s *Service) ReminderDays(ctx context.Context) []int {
	settings, err := s.store.AlertEventSettings(ctx)
	if err == nil {
		if st, ok := settings[EventSecretExpiring]; ok {
			if days := daysFromOptions(st.Options); len(days) > 0 {
				return days
			}
		}
	}
	return append([]int(nil), DefaultDays...)
}

func daysFromOptions(opts map[string]any) []int {
	raw, _ := opts["days"].([]any)
	var out []int
	for _, v := range raw {
		if f, ok := v.(float64); ok && f >= 1 && f <= 365 {
			out = append(out, int(f))
		}
	}
	return normalizeDays(out)
}

// ---- delivery ----

// Notify delivers a message in the background if its event is switched on.
func (s *Service) Notify(m Message) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		s.NotifySync(ctx, m)
	}()
}

// NotifySync delivers a message and waits. With a DedupeKey, a channel that
// already received it is skipped, and one that keeps failing is given up on.
func (s *Service) NotifySync(ctx context.Context, m Message) {
	if !s.eventEnabled(ctx, m.Event) {
		return
	}
	channels, err := s.store.ListAlertChannels(ctx, true)
	if err != nil {
		s.log.Error("alerts: list channels", "err", err)
		return
	}
	var wg sync.WaitGroup
	for _, ch := range channels {
		if m.DedupeKey != "" {
			sent, failures, err := s.store.AlertDeliveryState(ctx, m.DedupeKey, ch.ID)
			if err == nil && (sent || failures >= maxAttempts) {
				continue
			}
		}
		wg.Add(1)
		go func(ch *store.AlertChannel) {
			defer wg.Done()
			s.deliver(ctx, m, ch)
		}(ch)
	}
	wg.Wait()
}

// deliver sends to one channel and records the outcome.
func (s *Service) deliver(ctx context.Context, m Message, ch *store.AlertChannel) error {
	err := s.send(ctx, m, ch)

	rec := &store.AlertRecord{Event: m.Event, ChannelID: &ch.ID, ChannelName: ch.Name, Title: m.headline(), Status: "sent"}
	if m.ProjectKey != "" {
		rec.ProjectKey = &m.ProjectKey
	}
	if m.ServiceKey != "" {
		rec.ServiceKey = &m.ServiceKey
	}
	if m.DedupeKey != "" {
		rec.DedupeKey = &m.DedupeKey
	}
	if err != nil {
		msg := clip(err.Error(), 300)
		rec.Status, rec.Error = "failed", &msg
		s.log.Warn("alert delivery failed", "event", m.Event, "channel", ch.Name, "type", ch.Type, "err", msg)
	}
	if rerr := s.store.RecordAlert(context.Background(), rec); rerr != nil {
		s.log.Error("alerts: record delivery", "err", rerr)
	}
	return err
}

func (s *Service) send(ctx context.Context, m Message, ch *store.AlertChannel) error {
	cfg, err := s.DecryptConfig(ch.ConfigEnc)
	if err != nil {
		return errors.New("channel settings can't be read (was REXUS_MASTER_KEY changed?)")
	}
	return s.sender.Send(ctx, ch.Type, cfg, m)
}

// Test sends a test message to one channel right now and reports the result.
func (s *Service) Test(ctx context.Context, ch *store.AlertChannel) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	return s.deliver(ctx, Message{
		Event:    "test",
		Severity: "info",
		Headline: "Rexus test alert",
		Lines:    []string{"If you can read this, alerts to “" + ch.Name + "” work.", s.company},
		Link:     s.baseURL,
	}, ch)
}

// SendEmail sends one email through the relay (used for invite and reset links).
func (s *Service) SendEmail(ctx context.Context, to, subject, body string) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	return s.mailer.Send(ctx, []string{to}, subject, body)
}
