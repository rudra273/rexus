package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A switched-off module must look exactly like a route that doesn't exist, and switching it on or off must
// take effect on the very next request (no restart, no re-registration).
func TestModuleGateFollowsTheLiveSwitch(t *testing.T) {
	s := &Server{}
	on := false
	called := 0
	h := s.moduleGate(func() bool { return on })(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	})
	get := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", "/api/secrets", nil))
		return rec
	}

	rec := get()
	if rec.Code != http.StatusNotFound || called != 0 {
		t.Fatalf("module off: got %d (handler called %d times), want 404 and the handler never reached", rec.Code, called)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"not found"`) {
		t.Fatalf("module off: body %q should be the same JSON as an unknown /api/ route", body)
	}

	on = true
	if rec := get(); rec.Code != http.StatusOK || called != 1 {
		t.Fatalf("module on: got %d (called %d), want 200 and the handler reached", rec.Code, called)
	}

	on = false
	if rec := get(); rec.Code != http.StatusNotFound || called != 1 {
		t.Fatalf("switched off again: got %d (called %d), want 404 and no new call", rec.Code, called)
	}
}
