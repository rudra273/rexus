package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type locationTransport func(*http.Request) (*http.Response, error)

func (f locationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDestinationLookup(t *testing.T) {
	original := http.DefaultClient
	defer func() { http.DefaultClient = original }()
	calls := 0
	http.DefaultClient = &http.Client{Transport: locationTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://ipwho.is/8.8.8.8" {
			t.Fatalf("unexpected provider request: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"country":"United States","city":"Mountain View","latitude":37.4,"longitude":-122.1}`)), Header: make(http.Header)}, nil
	})}
	for _, host := range []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "::1", "169.254.169.254", "fd00::1"} {
		if got := lookupDestination(context.Background(), host); got != nil {
			t.Errorf("private host %s was mapped", host)
		}
	}
	if calls != 0 {
		t.Fatal("private addresses reached the provider")
	}
	got := lookupDestination(context.Background(), "8.8.8.8")
	if got == nil || got.Country != "United States" || got.Latitude != 37.4 || got.IP != "8.8.8.8" {
		t.Fatalf("unexpected location: %+v", got)
	}
	if host := destinationHost("https://user:secret@example.com/private?token=secret"); host != "example.com" {
		t.Fatalf("unexpected host: %q", host)
	}
}
