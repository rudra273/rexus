package alerts

import (
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Channel types.
const (
	TypeTelegram = "telegram"
	TypeDiscord  = "discord"
	TypeSlack    = "slack"
	TypeEmail    = "email"
)

// Config holds the settings of one channel; only the fields for its type are
// used. It is stored encrypted — bot tokens and webhook URLs are secrets.
type Config struct {
	BotToken      string          `json:"bot_token,omitempty"`       // telegram
	ChatID        string          `json:"chat_id,omitempty"`         // telegram
	WebhookURL    string          `json:"webhook_url,omitempty"`     // discord, slack
	To            []string        `json:"to,omitempty"`              // email
	CommandChatID *string         `json:"command_chat_id,omitempty"` // Telegram numeric chat ID; empty disables replies
	Digest        *DigestSchedule `json:"digest,omitempty"`          // Telegram daily digest; empty time disables it
}

type DigestSchedule struct {
	Time     string `json:"time"`
	Timezone string `json:"timezone"`
}

// IsEmpty reports whether no field is set (used to tell "keep the old config" from "replace it").
func (c *Config) IsEmpty() bool {
	return c.BotToken == "" && c.ChatID == "" && c.WebhookURL == "" && len(c.To) == 0 && c.CommandChatID == nil && c.Digest == nil
}

var (
	telegramTokenRe = regexp.MustCompile(`^\d{5,}:[A-Za-z0-9_-]{20,}$`)
	telegramChatRe  = regexp.MustCompile(`^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$`)
)

// Webhooks are only accepted for the real services, so a channel can't be
// used to make Rexus call arbitrary internal addresses.
var (
	discordHosts = map[string]bool{"discord.com": true, "discordapp.com": true, "ptb.discord.com": true, "canary.discord.com": true}
	slackHosts   = map[string]bool{"hooks.slack.com": true, "hooks.slack-gov.com": true}
)

// Validate checks (and tidies) a config for the given channel type.
func (c *Config) Validate(typ string, smtpConfigured bool) error {
	c.BotToken = strings.TrimSpace(c.BotToken)
	c.ChatID = strings.TrimSpace(c.ChatID)
	c.WebhookURL = strings.TrimSpace(c.WebhookURL)
	if typ != TypeTelegram {
		c.CommandChatID, c.Digest = nil, nil
	}

	switch typ {
	case TypeTelegram:
		if !telegramTokenRe.MatchString(c.BotToken) {
			return errors.New("that doesn't look like a Telegram bot token (from @BotFather, e.g. 123456789:AAH…)")
		}
		if !telegramChatRe.MatchString(c.ChatID) {
			return errors.New("chat ID must be a number (e.g. -1001234567890 for a group) or @channelname")
		}
		if c.CommandChatID != nil {
			raw := strings.TrimSpace(*c.CommandChatID)
			if raw != "" {
				id, err := strconv.ParseInt(raw, 10, 64)
				if err != nil || id == 0 || strconv.FormatInt(id, 10) != raw {
					return errors.New("command chat ID must be a numeric Telegram chat ID")
				}
			}
			c.CommandChatID = &raw
		}
		if c.Digest != nil && c.Digest.Time != "" {
			clock, err := time.Parse("15:04", c.Digest.Time)
			if err != nil || clock.Format("15:04") != c.Digest.Time {
				return errors.New("digest time must use HH:MM")
			}
			c.Digest.Timezone = strings.TrimSpace(c.Digest.Timezone)
			if _, err := time.LoadLocation(c.Digest.Timezone); err != nil || c.Digest.Timezone == "" || c.Digest.Timezone == "Local" {
				return errors.New("enter a timezone such as Asia/Kolkata or UTC")
			}
		}
		c.WebhookURL, c.To = "", nil
	case TypeDiscord:
		if err := checkWebhook(c.WebhookURL, discordHosts, "/api/webhooks/", "Discord"); err != nil {
			return err
		}
		c.BotToken, c.ChatID, c.To = "", "", nil
	case TypeSlack:
		if err := checkWebhook(c.WebhookURL, slackHosts, "/services/", "Slack"); err != nil {
			return err
		}
		c.BotToken, c.ChatID, c.To = "", "", nil
	case TypeEmail:
		if !smtpConfigured {
			return errors.New("email isn't set up on this server — set REXUS_SMTP_HOST, REXUS_SMTP_FROM (and credentials) in .env, then restart Rexus")
		}
		if len(c.To) == 0 || len(c.To) > 10 {
			return errors.New("enter 1–10 email addresses")
		}
		seen := map[string]bool{}
		clean := make([]string, 0, len(c.To))
		for _, a := range c.To {
			a = strings.TrimSpace(a)
			addr, err := mail.ParseAddress(a)
			if err != nil || addr.Address != a {
				return fmt.Errorf("%q is not a valid email address", a)
			}
			if k := strings.ToLower(a); !seen[k] {
				seen[k] = true
				clean = append(clean, a)
			}
		}
		c.To = clean
		c.BotToken, c.ChatID, c.WebhookURL = "", "", ""
	default:
		return fmt.Errorf("unknown channel type %q", typ)
	}
	return nil
}

func checkWebhook(raw string, hosts map[string]bool, pathPrefix, service string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !hosts[strings.ToLower(u.Hostname())] || !strings.HasPrefix(u.Path, pathPrefix) {
		return fmt.Errorf("that doesn't look like a %s webhook URL", service)
	}
	return nil
}

// Summary describes the channel for the UI without revealing secrets.
func (c *Config) Summary(typ string) string {
	switch typ {
	case TypeTelegram:
		return "chat " + c.ChatID
	case TypeDiscord, TypeSlack:
		u, err := url.Parse(c.WebhookURL)
		if err != nil {
			return "webhook"
		}
		tail := u.Path
		if len(tail) > 4 {
			tail = tail[len(tail)-4:]
		}
		return u.Hostname() + "/…" + tail
	case TypeEmail:
		return strings.Join(c.To, ", ")
	}
	return ""
}
