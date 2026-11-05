package server

import (
	"bytes"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// The owner's email is private to the owner. Everyone else — admins,
// contributors, viewers — sees it masked wherever it appears ("created by",
// the Users page, the audit log, secret history…). It is done on the server,
// on the way out, so it holds for every endpoint and can't be bypassed by
// reading the API instead of the UI.

// maskEmail turns "rudra@gmail.com" into "r***@gmail.com".
func maskEmail(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 1 {
		return "***"
	}
	first := []rune(email)[0]
	return string(first) + "***" + email[at:]
}

// maskWriter buffers a response and, when it is flushed, replaces the owner's
// email (any letter case) with its masked form.
type maskWriter struct {
	http.ResponseWriter
	re     *regexp.Regexp
	masked []byte
	status int
	buf    bytes.Buffer
}

func newMaskWriter(w http.ResponseWriter, ownerEmail string) *maskWriter {
	return &maskWriter{
		ResponseWriter: w,
		re:             regexp.MustCompile(`(?i)` + regexp.QuoteMeta(ownerEmail)),
		masked:         []byte(maskEmail(ownerEmail)),
	}
}

func (m *maskWriter) WriteHeader(code int) { m.status = code }

func (m *maskWriter) Write(b []byte) (int, error) { return m.buf.Write(b) }

// Flush sends the buffered response. Call it once, after the handler returns.
func (m *maskWriter) Flush() {
	body := m.re.ReplaceAll(m.buf.Bytes(), m.masked)
	if m.status == 0 {
		m.status = http.StatusOK
	}
	m.Header().Set("Content-Length", strconv.Itoa(len(body)))
	m.ResponseWriter.WriteHeader(m.status)
	m.ResponseWriter.Write(body)
}
