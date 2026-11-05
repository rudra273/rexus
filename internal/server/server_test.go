package server

import (
	"net/http/httptest"
	"testing"

	"rexus/internal/store"
)

func u(id, role string) *store.User { return &store.User{ID: id, Role: role} }

func TestCanManage(t *testing.T) {
	owner, admin, admin2 := u("1", "owner"), u("2", "admin"), u("3", "admin")
	contrib, viewer := u("4", "contributor"), u("5", "viewer")

	cases := []struct {
		name          string
		actor, target *store.User
		want          bool
	}{
		{"owner manages admin", owner, admin, true},
		{"owner manages contributor", owner, contrib, true},
		{"owner can't manage self", owner, owner, false},
		{"admin manages contributor", admin, contrib, true},
		{"admin manages viewer", admin, viewer, true},
		{"admin can't manage another admin", admin, admin2, false},
		{"admin can't manage the owner", admin, owner, false},
		{"admin can't manage self", admin, admin, false},
		{"contributor manages nobody", contrib, viewer, false},
		{"viewer manages nobody", viewer, contrib, false},
	}
	for _, c := range cases {
		if got := canManage(c.actor, c.target); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestAssignableRoles(t *testing.T) {
	if !roleAssignable("owner", "admin") || !roleAssignable("owner", "viewer") {
		t.Error("owner should assign admin/contributor/viewer")
	}
	if roleAssignable("owner", "owner") || roleAssignable("admin", "owner") {
		t.Error("the owner role must never be assignable")
	}
	if roleAssignable("admin", "admin") {
		t.Error("an admin must not create admins")
	}
	if !roleAssignable("admin", "contributor") || !roleAssignable("admin", "viewer") {
		t.Error("admin should assign contributor/viewer")
	}
	if roleAssignable("contributor", "viewer") || roleAssignable("viewer", "viewer") {
		t.Error("contributors and viewers assign nothing")
	}
}

func TestCanWrite(t *testing.T) {
	for role, want := range map[string]bool{"owner": true, "admin": true, "contributor": true, "viewer": false, "": false} {
		if got := canWrite(role); got != want {
			t.Errorf("canWrite(%q) = %v, want %v", role, got, want)
		}
	}
}

func TestClientIP(t *testing.T) {
	req := func(remote string, headers map[string]string) string {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return clientIP(r)
	}
	// Direct public connection: headers must be ignored (can't be spoofed).
	if got := req("203.0.113.9:5555", map[string]string{"X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4"}); got != "203.0.113.9" {
		t.Errorf("public peer must not be spoofable, got %s", got)
	}
	// Behind a local tunnel: use the proxy's header.
	if got := req("127.0.0.1:5555", map[string]string{"CF-Connecting-IP": "198.51.100.7"}); got != "198.51.100.7" {
		t.Errorf("cloudflared header ignored, got %s", got)
	}
	// XFF: take the rightmost entry (appended by our proxy), not the client-supplied first.
	if got := req("172.18.0.1:5555", map[string]string{"X-Forwarded-For": "6.6.6.6, 198.51.100.8"}); got != "198.51.100.8" {
		t.Errorf("XFF rightmost expected, got %s", got)
	}
	// No headers: the peer itself.
	if got := req("192.168.0.20:1234", nil); got != "192.168.0.20" {
		t.Errorf("got %s", got)
	}
	// Garbage header is ignored.
	if got := req("127.0.0.1:1", map[string]string{"CF-Connecting-IP": "not-an-ip"}); got != "127.0.0.1" {
		t.Errorf("got %s", got)
	}
}
