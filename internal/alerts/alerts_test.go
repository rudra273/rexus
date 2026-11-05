package alerts

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func init() { retryDelay = time.Millisecond }

var sample = Message{
	Event:    EventCheckDown,
	Severity: "critical",
	Headline: "DOWN — Acme <Web> & Co (acme-web)",
	Lines:    []string{"Check: Site — GET https://acme.com", "Reason: timeout after 10s"},
	Link:     "https://rexus.example.com/checks/abc",
}

// ---- formats ----

func TestFormatsEscapeUserText(t *testing.T) {
	tg := sample.telegramHTML()
	if !strings.Contains(tg, "Acme &lt;Web&gt; &amp; Co") || strings.Contains(tg, "<Web>") {
		t.Errorf("telegram must escape HTML: %s", tg)
	}
	if !strings.Contains(tg, `<a href="https://rexus.example.com/checks/abc">Open in Rexus</a>`) {
		t.Errorf("telegram link missing: %s", tg)
	}
	sl := sample.slackText()
	if !strings.Contains(sl, "Acme &lt;Web&gt; &amp; Co") || !strings.Contains(sl, "<https://rexus.example.com/checks/abc|Open in Rexus>") {
		t.Errorf("slack text wrong: %s", sl)
	}
	plain := sample.Plain()
	if !strings.HasPrefix(plain, "🔴 DOWN") || !strings.Contains(plain, "Open: https://rexus.example.com/checks/abc") {
		t.Errorf("plain text wrong: %s", plain)
	}
}

func TestDiscordCannotPingAnyone(t *testing.T) {
	m := sample
	m.Headline = "DOWN — @everyone <@123456789>"
	b, _ := json.Marshal(m.discordPayload())
	var p struct {
		AllowedMentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
		Embeds []map[string]any `json:"embeds"`
	}
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	if p.AllowedMentions.Parse == nil || len(p.AllowedMentions.Parse) != 0 {
		t.Fatalf("allowed_mentions.parse must be an empty list, got %v", p.AllowedMentions.Parse)
	}
	if len(p.Embeds) != 1 || p.Embeds[0]["url"] != sample.Link {
		t.Fatalf("embed wrong: %v", p.Embeds)
	}
}

func TestMessagesAreSingleLineHeadlines(t *testing.T) {
	m := Message{Severity: "info", Headline: "a\r\nBcc: evil@x", Lines: []string{"x\ny"}}
	if strings.Contains(m.headline(), "\n") || strings.Contains(m.emailSubject(), "\n") {
		t.Fatal("headline must not contain newlines")
	}
	if strings.Count(m.Plain(), "\n") != 1 {
		t.Fatalf("lines must stay single lines: %q", m.Plain())
	}
}

func TestHumanDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		20 * time.Second:              "under a minute",
		12 * time.Minute:              "12m",
		3*time.Hour + 5*time.Minute:   "3h 5m",
		50*time.Hour + 30*time.Minute: "2d 2h",
	} {
		if got := humanDuration(d); got != want {
			t.Errorf("%v: got %q want %q", d, got, want)
		}
	}
}

// ---- channel validation ----

func TestValidateTelegram(t *testing.T) {
	ok := Config{BotToken: "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123", ChatID: "-1001234567890"}
	if err := ok.Validate(TypeTelegram, false); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]Config{
		"bad token":   {BotToken: "not-a-token", ChatID: "123"},
		"bad chat id": {BotToken: ok.BotToken, ChatID: "my chat"},
		"empty":       {},
	} {
		if err := c.Validate(TypeTelegram, false); err == nil {
			t.Errorf("%s should be rejected", name)
		}
	}
	chan1 := Config{BotToken: ok.BotToken, ChatID: "@mychannel"}
	if err := chan1.Validate(TypeTelegram, false); err != nil {
		t.Errorf("@channel names are valid: %v", err)
	}
}

func TestValidateWebhooksOnlyForRealServices(t *testing.T) {
	good := map[string]string{
		TypeDiscord: "https://discord.com/api/webhooks/123/abcdef",
		TypeSlack:   "https://hooks.slack.com/services/T000/B000/XXXX",
	}
	for typ, u := range good {
		c := Config{WebhookURL: u}
		if err := c.Validate(typ, false); err != nil {
			t.Errorf("%s: %v", typ, err)
		}
	}
	bad := []struct{ typ, url string }{
		{TypeDiscord, "http://discord.com/api/webhooks/1/a"},               // not https
		{TypeDiscord, "https://discord.com.evil.example/api/webhooks/1/a"}, // look-alike host
		{TypeDiscord, "https://evil.example/https://discord.com/api/webhooks/1/a"},
		{TypeDiscord, "https://discord.com/other/1/a"}, // wrong path
		{TypeSlack, "https://hooks.slack.com.evil.example/services/T/B/X"},
		{TypeSlack, "http://127.0.0.1:8090/services/T/B/X"}, // internal address
		{TypeSlack, "https://hooks.slack.com/api/x"},
		{TypeSlack, ""},
	}
	for _, b := range bad {
		c := Config{WebhookURL: b.url}
		if err := c.Validate(b.typ, false); err == nil {
			t.Errorf("%s %q should be rejected", b.typ, b.url)
		}
	}
}

func TestValidateEmail(t *testing.T) {
	c := Config{To: []string{"a@example.com"}}
	if err := c.Validate(TypeEmail, false); err == nil || !strings.Contains(err.Error(), "REXUS_SMTP_HOST") {
		t.Fatalf("email without SMTP must explain how to set it up: %v", err)
	}
	c = Config{To: []string{"a@example.com", "A@example.com", " b@example.com "}}
	if err := c.Validate(TypeEmail, true); err != nil {
		t.Fatal(err)
	}
	if len(c.To) != 2 {
		t.Fatalf("duplicates (case-insensitive) should collapse, got %v", c.To)
	}
	for _, to := range [][]string{nil, {"not an email"}, {"Bob <bob@example.com>"}, make([]string, 11)} {
		bad := Config{To: to}
		if err := bad.Validate(TypeEmail, true); err == nil {
			t.Errorf("%v should be rejected", to)
		}
	}
}

func TestSummaryHidesSecrets(t *testing.T) {
	tg := Config{BotToken: "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123", ChatID: "-100123"}
	if s := tg.Summary(TypeTelegram); strings.Contains(s, "AAH") || s != "chat -100123" {
		t.Errorf("telegram summary leaks the token: %q", s)
	}
	sl := Config{WebhookURL: "https://hooks.slack.com/services/T000/B000/SECRETSECRETWXYZ"}
	if s := sl.Summary(TypeSlack); strings.Contains(s, "SECRET") || !strings.HasSuffix(s, "WXYZ") {
		t.Errorf("slack summary leaks the webhook: %q", s)
	}
}

// ---- reminders ----

func TestBucket(t *testing.T) {
	th := []int{30, 7, 1}
	cases := []struct {
		days int
		want string
		ok   bool
	}{
		{45, "", false}, {31, "", false}, {30, "30", true}, {20, "30", true}, {8, "30", true},
		{7, "7", true}, {5, "7", true}, {2, "7", true}, {1, "1", true}, {0, "1", true}, {-1, "expired", true}, {-40, "expired", true},
	}
	for _, c := range cases {
		got, ok := Bucket(c.days, th)
		if got != c.want || ok != c.ok {
			t.Errorf("%d days: got (%q,%v) want (%q,%v)", c.days, got, ok, c.want, c.ok)
		}
	}
	// Threshold order must not matter.
	if got, _ := Bucket(5, []int{1, 30, 7}); got != "7" {
		t.Errorf("order-independent: got %q", got)
	}
}

func TestSSLThresholds(t *testing.T) {
	for warn, want := range map[int][]int{14: {14, 7, 1}, 7: {7, 1}, 3: {3, 1}, 1: {1}, 30: {30, 7, 1}} {
		got := sslThresholds(warn)
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("warn %d: got %v want %v", warn, got, want)
		}
	}
}

func TestNormalizeDays(t *testing.T) {
	got := normalizeDays([]int{1, 30, 7, 7, 0, 400, 14})
	if fmt.Sprint(got) != "[30 14 7 1]" {
		t.Fatalf("got %v", got)
	}
}

func TestExpiryText(t *testing.T) {
	for d, want := range map[int]string{-3: "expired 3 days ago", -1: "expired 1 day ago", 0: "expires today", 1: "expires in 1 day", 5: "expires in 5 days"} {
		if got := expiryText(d); got != want {
			t.Errorf("%d: got %q want %q", d, got, want)
		}
	}
}

// ---- senders ----

func newTestSender() *Sender { return newSender(&Mailer{}) }

func TestSlackSuccessAndFailureModes(t *testing.T) {
	var calls int32
	var mode atomic.Value
	mode.Store("ok")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Content-Type") != "application/json" || !strings.Contains(string(body), "Open in Rexus") {
			t.Errorf("bad request: %s %s", r.Header.Get("Content-Type"), body)
		}
		switch mode.Load() {
		case "ok":
			w.Write([]byte("ok"))
		case "gone":
			w.WriteHeader(404)
			w.Write([]byte("no_service"))
		case "boom":
			w.WriteHeader(503)
		case "redirect":
			http.Redirect(w, r, "http://127.0.0.1:1/never", http.StatusFound)
		}
	}))
	defer srv.Close()
	s := newTestSender()
	cfg := &Config{WebhookURL: srv.URL}
	ctx := context.Background()

	if err := s.Send(ctx, TypeSlack, cfg, sample); err != nil || atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("ok case: err=%v calls=%d", err, calls)
	}

	mode.Store("gone")
	atomic.StoreInt32(&calls, 0)
	err := s.Send(ctx, TypeSlack, cfg, sample)
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") || !strings.Contains(err.Error(), "no_service") {
		t.Fatalf("404 should surface Slack's reason: %v", err)
	}
	if calls != 1 {
		t.Errorf("a 404 must not be retried (calls=%d)", calls)
	}

	mode.Store("boom")
	atomic.StoreInt32(&calls, 0)
	if err := s.Send(ctx, TypeSlack, cfg, sample); err == nil || calls != 2 {
		t.Fatalf("a 503 is retried exactly once: err=%v calls=%d", err, calls)
	}

	mode.Store("redirect")
	if err := s.Send(ctx, TypeSlack, cfg, sample); err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("redirects must not be followed: %v", err)
	}
}

func TestDiscordSendsEmbed(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := newTestSender().Send(context.Background(), TypeDiscord, &Config{WebhookURL: srv.URL}, sample); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["embeds"]; !ok {
		t.Fatalf("no embed sent: %v", got)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"message":"Invalid Webhook Token","code":50027}`))
	}))
	defer bad.Close()
	err := newTestSender().Send(context.Background(), TypeDiscord, &Config{WebhookURL: bad.URL}, sample)
	if err == nil || !strings.Contains(err.Error(), "Invalid Webhook Token") {
		t.Fatalf("Discord's reason should be shown: %v", err)
	}
}

func TestTelegramRequestAndNoTokenLeak(t *testing.T) {
	const token = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123"
	var path string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		json.NewDecoder(r.Body).Decode(&body)
		w.Write([]byte(`{"ok":true}`))
	}))
	s := newTestSender()
	s.telegramBase = srv.URL
	cfg := &Config{BotToken: token, ChatID: "-100123"}
	if err := s.Send(context.Background(), TypeTelegram, cfg, sample); err != nil {
		t.Fatal(err)
	}
	if path != "/bot"+token+"/sendMessage" || body["chat_id"] != "-100123" || body["parse_mode"] != "HTML" {
		t.Fatalf("bad telegram request: %s %v", path, body)
	}

	// Telegram's own error text is shown…
	srv.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		w.Write([]byte(`{"ok":false,"description":"Bad Request: chat not found"}`))
	}))
	s.telegramBase = bad.URL
	err := s.Send(context.Background(), TypeTelegram, cfg, sample)
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("got %v", err)
	}
	bad.Close()

	// …and when the connection itself fails, the URL (which holds the token) is not in the error.
	s.telegramBase = bad.URL // now closed
	err = s.Send(context.Background(), TypeTelegram, cfg, sample)
	if err == nil {
		t.Fatal("expected a connection error")
	}
	if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "AAH") {
		t.Fatalf("bot token leaked into the error: %v", err)
	}
}

// ---- email ----

// fakeSMTP is a tiny SMTP server that records the message it receives.
func fakeSMTP(t *testing.T, startTLS bool) (host string, port int, data <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	out := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		fmt.Fprint(conn, "220 fake ESMTP\r\n")
		var msg strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					out <- msg.String()
					fmt.Fprint(conn, "250 queued\r\n")
					continue
				}
				msg.WriteString(line)
				continue
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(cmd, "EHLO"):
				fmt.Fprint(conn, "250-fake\r\n250 8BITMIME\r\n")
			case cmd == "DATA":
				inData = true
				fmt.Fprint(conn, "354 go ahead\r\n")
			case cmd == "QUIT":
				fmt.Fprint(conn, "221 bye\r\n")
				return
			default:
				fmt.Fprint(conn, "250 OK\r\n")
			}
		}
	}()
	h, p, _ := net.SplitHostPort(ln.Addr().String())
	pn, _ := strconv.Atoi(p)
	return h, pn, out
}

func TestSMTPDeliversWellFormedMessage(t *testing.T) {
	host, port, data := fakeSMTP(t, false)
	m := &Mailer{cfg: SMTPConfig{Host: host, Port: port, From: "Rexus <rexus@example.com>"}}
	subject := "[Rexus] DOWN — Acme Web (acme-web)"
	body := "🔴 DOWN — Acme\nCheck: café ☕\n.starts with a dot\nOpen: https://rexus.example.com/checks/abc\n"
	if err := m.Send(context.Background(), []string{"ops@example.com", "dev@example.com"}, subject, body); err != nil {
		t.Fatal(err)
	}
	raw := <-data
	head, rest, ok := strings.Cut(raw, "\r\n\r\n")
	if !ok {
		t.Fatalf("no header/body split: %q", raw)
	}
	for _, want := range []string{"From: \"Rexus\" <rexus@example.com>", "To: ops@example.com, dev@example.com", "MIME-Version: 1.0", "charset=UTF-8"} {
		if !strings.Contains(head, want) && !strings.Contains(head, strings.ReplaceAll(want, "\"Rexus\"", "Rexus")) {
			t.Errorf("header missing %q in:\n%s", want, head)
		}
	}
	var subj string
	for _, l := range strings.Split(head, "\r\n") {
		if strings.HasPrefix(l, "Subject: ") {
			subj, _ = (&mime.WordDecoder{}).DecodeHeader(strings.TrimPrefix(l, "Subject: "))
		}
	}
	if subj != subject {
		t.Errorf("subject round trip: got %q", subj)
	}
	decoded, err := io.ReadAll(quotedprintable.NewReader(strings.NewReader(rest)))
	if err != nil {
		t.Fatal(err)
	}
	got := strings.ReplaceAll(string(decoded), "\r\n", "\n")
	// The server received the dot-stuffed form on the wire; after decoding the body is intact.
	if !strings.Contains(got, "café ☕") || !strings.Contains(got, "Open: https://rexus.example.com/checks/abc") {
		t.Errorf("body mangled: %q", got)
	}
}

func TestSMTPRefusesPasswordWithoutTLS(t *testing.T) {
	host, port, _ := fakeSMTP(t, false)
	m := &Mailer{cfg: SMTPConfig{Host: host, Port: port, User: "u", Password: "secret", From: "rexus@example.com"}}
	err := m.Send(context.Background(), []string{"a@example.com"}, "x", "y")
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("must refuse to send a password in the clear: %v", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatal("password leaked into the error")
	}
}

func TestSMTPHeaderInjection(t *testing.T) {
	host, port, data := fakeSMTP(t, false)
	m := &Mailer{cfg: SMTPConfig{Host: host, Port: port, From: "rexus@example.com"}}
	if err := m.Send(context.Background(), []string{"a@example.com"}, "Hi\r\nBcc: evil@example.com", "body"); err != nil {
		t.Fatal(err)
	}
	head, _, _ := strings.Cut(<-data, "\r\n\r\n")
	for _, l := range strings.Split(head, "\r\n") {
		if strings.HasPrefix(strings.ToLower(l), "bcc:") {
			t.Fatalf("header injection: %q", l)
		}
	}
}

func TestSMTPNotConfigured(t *testing.T) {
	if err := (&Mailer{}).Send(context.Background(), []string{"a@example.com"}, "s", "b"); err == nil {
		t.Fatal("expected an error")
	}
	if (SMTPConfig{}).Configured() || !(SMTPConfig{Host: "x"}).Configured() {
		t.Fatal("Configured() wrong")
	}
}
