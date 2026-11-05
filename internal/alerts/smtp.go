package alerts

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// SMTPConfig is the optional outgoing-mail relay (REXUS_SMTP_* env vars):
// Resend, Amazon SES, Gmail SMTP, Mailgun, your own server…
type SMTPConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	From     string
}

func (c SMTPConfig) Configured() bool { return c.Host != "" }

// Mailer sends plain-text email through the relay. Port 465 uses TLS from the
// start; any other port uses STARTTLS when the server offers it. The password
// is never sent over an unencrypted connection.
type Mailer struct{ cfg SMTPConfig }

func stripCRLF(s string) string { return strings.NewReplacer("\r", "", "\n", "").Replace(s) }

func (m *Mailer) Send(ctx context.Context, to []string, subject, body string) error {
	if !m.cfg.Configured() {
		return errors.New("email is not configured (REXUS_SMTP_HOST)")
	}
	from, err := mail.ParseAddress(m.cfg.From)
	if err != nil {
		return fmt.Errorf("invalid REXUS_SMTP_FROM: %w", err)
	}
	port := m.cfg.Port
	if port == 0 {
		port = 587
	}
	addr := net.JoinHostPort(m.cfg.Host, strconv.Itoa(port))

	d := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	if port == 465 {
		conn, err = tls.DialWithDialer(&d, "tcp", addr, &tls.Config{ServerName: m.cfg.Host})
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("can't connect to the mail server: %s", cleanErr(err))
	}
	conn.SetDeadline(time.Now().Add(30 * time.Second))

	c, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("mail server: %w", err)
	}
	defer c.Close()

	if port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: m.cfg.Host}); err != nil {
				return fmt.Errorf("mail server TLS: %w", err)
			}
		} else if m.cfg.User != "" {
			return errors.New("the mail server doesn't offer STARTTLS — refusing to send the password unencrypted (try port 465 or 587)")
		}
	}
	if m.cfg.User != "" {
		if err := c.Auth(smtp.PlainAuth("", m.cfg.User, m.cfg.Password, m.cfg.Host)); err != nil {
			return fmt.Errorf("mail server login failed: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("mail server rejected the sender: %w", err)
	}
	for _, rcpt := range to {
		if err := c.Rcpt(rcpt); err != nil {
			return fmt.Errorf("mail server rejected %s: %w", rcpt, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(buildMessage(from, to, subject, body)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mail server refused the message: %w", err)
	}
	return c.Quit()
}

func buildMessage(from *mail.Address, to []string, subject, body string) []byte {
	var id [12]byte
	rand.Read(id[:])
	domain := "rexus.local"
	if i := strings.LastIndex(from.Address, "@"); i >= 0 {
		domain = from.Address[i+1:]
	}

	var b bytes.Buffer
	h := func(k, v string) { b.WriteString(k + ": " + stripCRLF(v) + "\r\n") }
	h("From", from.String())
	h("To", strings.Join(to, ", "))
	h("Subject", mime.QEncoding.Encode("utf-8", subject))
	h("Date", time.Now().Format(time.RFC1123Z))
	h("Message-ID", "<"+hex.EncodeToString(id[:])+"@"+domain+">")
	h("MIME-Version", "1.0")
	h("Content-Type", "text/plain; charset=UTF-8")
	h("Content-Transfer-Encoding", "quoted-printable")
	h("X-Auto-Response-Suppress", "All")
	b.WriteString("\r\n")
	qp := quotedprintable.NewWriter(&b)
	qp.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")))
	qp.Close()
	return b.Bytes()
}
