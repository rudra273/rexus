package alerts

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// Message is one alert, independent of where it is delivered. Every message
// carries the project and a link back into Rexus (plan.md §8.1).
type Message struct {
	Event      string
	Severity   string // critical | warning | ok | info
	Headline   string // e.g. "DOWN — Acme Web (acme-web)"
	Lines      []string
	Link       string
	ProjectKey string
	DedupeKey  string // set for reminders: each goes to each channel once
}

func emojiFor(sev string) string {
	switch sev {
	case "critical":
		return "🔴"
	case "warning":
		return "🟡"
	case "ok":
		return "🟢"
	}
	return "🔵"
}

func colorFor(sev string) int {
	switch sev {
	case "critical":
		return 0xEF4444
	case "warning":
		return 0xF59E0B
	case "ok":
		return 0x10B981
	}
	return 0x3B82F6
}

func oneLine(s string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(s))
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func (m Message) headline() string { return clip(oneLine(m.Headline), 200) }

func (m Message) lines() []string {
	var out []string
	for _, l := range m.Lines {
		if l = clip(oneLine(l), 400); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// Plain is the text form, used for logs and as the email body.
func (m Message) Plain() string {
	var b strings.Builder
	b.WriteString(emojiFor(m.Severity) + " " + m.headline())
	for _, l := range m.lines() {
		b.WriteString("\n" + l)
	}
	if m.Link != "" {
		b.WriteString("\nOpen: " + m.Link)
	}
	return b.String()
}

// telegramHTML escapes everything (project names are user-chosen) and links back to Rexus.
func (m Message) telegramHTML() string {
	var b strings.Builder
	b.WriteString(emojiFor(m.Severity) + " <b>" + html.EscapeString(m.headline()) + "</b>")
	for _, l := range m.lines() {
		b.WriteString("\n" + html.EscapeString(l))
	}
	if m.Link != "" {
		b.WriteString("\n<a href=\"" + html.EscapeString(m.Link) + "\">Open in Rexus</a>")
	}
	return clip(b.String(), 4000)
}

var slackEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func (m Message) slackText() string {
	var b strings.Builder
	b.WriteString(emojiFor(m.Severity) + " *" + slackEscape.Replace(m.headline()) + "*")
	for _, l := range m.lines() {
		b.WriteString("\n" + slackEscape.Replace(l))
	}
	if m.Link != "" {
		b.WriteString("\n<" + m.Link + "|Open in Rexus>")
	}
	return b.String()
}

// discordPayload never lets message text ping anyone (@everyone, roles, users).
func (m Message) discordPayload() map[string]any {
	embed := map[string]any{
		"title":       emojiFor(m.Severity) + " " + m.headline(),
		"description": clip(strings.Join(m.lines(), "\n"), 3500),
		"color":       colorFor(m.Severity),
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
	}
	if m.Link != "" {
		embed["url"] = m.Link
	}
	return map[string]any{
		"embeds":           []any{embed},
		"allowed_mentions": map[string]any{"parse": []string{}},
	}
}

func (m Message) emailSubject() string { return "[Rexus] " + m.headline() }

func (m Message) emailBody() string { return m.Plain() + "\n" }

// ---- helpers used when building messages ----

func fmtUTC(t time.Time) string { return t.UTC().Format("2006-01-02 15:04 UTC") }

func humanDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	switch {
	case d < time.Minute:
		return "under a minute"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd %dh", int(d.Hours())/24, int(d.Hours())%24)
}

func plural(n int, one, many string) string {
	if n == 1 || n == -1 {
		return one
	}
	return many
}
