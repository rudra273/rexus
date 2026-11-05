package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// sendError is a delivery failure. retry says whether trying again may help
// (network problem, rate limit, server error) or not (bad token, bad webhook).
type sendError struct {
	msg   string
	retry bool
}

func (e *sendError) Error() string { return e.msg }

var retryDelay = 2 * time.Second

// Sender delivers a Message to one channel.
type Sender struct {
	http         *http.Client
	telegramBase string
	mailer       *Mailer
}

func newSender(m *Mailer) *Sender {
	return &Sender{
		http: &http.Client{
			Timeout: 15 * time.Second,
			// A webhook that redirects is suspicious; never follow it.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		telegramBase: "https://api.telegram.org",
		mailer:       m,
	}
}

// cleanErr drops the request URL from Go's network errors — for Telegram
// that URL contains the bot token, and it must never reach logs or the UI.
func cleanErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err.Error()
	}
	return err.Error()
}

// Send delivers m, retrying once on failures that may be temporary.
func (s *Sender) Send(ctx context.Context, typ string, cfg *Config, m Message) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if err = s.sendOnce(ctx, typ, cfg, m); err == nil {
			return nil
		}
		var se *sendError
		if !errors.As(err, &se) || !se.retry {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(retryDelay):
		}
	}
	return err
}

func (s *Sender) sendOnce(ctx context.Context, typ string, cfg *Config, m Message) error {
	switch typ {
	case TypeTelegram:
		return s.telegram(ctx, cfg, m)
	case TypeSlack:
		return s.slack(ctx, cfg, m)
	case TypeDiscord:
		return s.discord(ctx, cfg, m)
	case TypeEmail:
		if err := s.mailer.Send(ctx, cfg.To, m.emailSubject(), m.emailBody()); err != nil {
			// A wrong password or address won't fix itself; connection trouble might.
			return &sendError{msg: err.Error(), retry: strings.Contains(err.Error(), "can't connect")}
		}
		return nil
	}
	return fmt.Errorf("unknown channel type %q", typ)
}

// post sends JSON and returns the status and (limited) body.
func (s *Sender) post(ctx context.Context, endpoint string, payload any) (int, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, &sendError{msg: "invalid webhook address"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Rexus-Alerts/1.0")
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, nil, &sendError{msg: cleanErr(err), retry: true}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, b, nil
}

func retryable(status int) bool { return status == http.StatusTooManyRequests || status >= 500 }

func (s *Sender) telegram(ctx context.Context, cfg *Config, m Message) error {
	status, body, err := s.post(ctx, s.telegramBase+"/bot"+cfg.BotToken+"/sendMessage", map[string]any{
		"chat_id":                  cfg.ChatID,
		"text":                     m.telegramHTML(),
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}
	if status == http.StatusOK {
		return nil
	}
	var r struct {
		Description string `json:"description"`
	}
	json.Unmarshal(body, &r)
	msg := fmt.Sprintf("Telegram returned HTTP %d", status)
	if r.Description != "" {
		msg = "Telegram: " + clip(r.Description, 200)
	}
	return &sendError{msg: msg, retry: retryable(status)}
}

func (s *Sender) slack(ctx context.Context, cfg *Config, m Message) error {
	status, body, err := s.post(ctx, cfg.WebhookURL, map[string]any{"text": m.slackText()})
	if err != nil {
		return err
	}
	if status >= 200 && status < 300 {
		return nil
	}
	msg := fmt.Sprintf("Slack returned HTTP %d", status)
	if t := strings.TrimSpace(string(body)); t != "" {
		msg += ": " + clip(oneLine(t), 120)
	}
	return &sendError{msg: msg, retry: retryable(status)}
}

func (s *Sender) discord(ctx context.Context, cfg *Config, m Message) error {
	status, body, err := s.post(ctx, cfg.WebhookURL, m.discordPayload())
	if err != nil {
		return err
	}
	if status >= 200 && status < 300 {
		return nil
	}
	msg := fmt.Sprintf("Discord returned HTTP %d", status)
	var r struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &r) == nil && r.Message != "" {
		msg = "Discord: " + clip(r.Message, 120)
	}
	return &sendError{msg: msg, retry: retryable(status)}
}
