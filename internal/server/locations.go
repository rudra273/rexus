package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	"rexus/internal/store"
)

type destinationLocation struct {
	Country   string  `json:"country"`
	City      string  `json:"city"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	IP        string  `json:"ip"`
}
type locationEntry struct {
	location *destinationLocation
	expires  time.Time
}

var destinationCache = struct {
	sync.Mutex
	entries map[string]locationEntry
	calls   singleflight.Group
	slots   chan struct{}
}{entries: make(map[string]locationEntry), slots: make(chan struct{}, 4)}

func destinationHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.Hostname()
}

// Only public destination IPs go to the provider. URLs, credentials and paths never leave Rexus.
func locateDestination(host string) *destinationLocation {
	result, _, _ := destinationCache.calls.Do(host, func() (any, error) {
		destinationCache.Lock()
		cached, ok := destinationCache.entries[host]
		destinationCache.Unlock()
		if ok && time.Now().Before(cached.expires) {
			return cached.location, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		location := lookupDestination(ctx, host)
		ttl := 24 * time.Hour
		if location == nil {
			ttl = time.Hour
		}
		destinationCache.Lock()
		for key, entry := range destinationCache.entries {
			if time.Now().After(entry.expires) {
				delete(destinationCache.entries, key)
			}
		}
		if len(destinationCache.entries) < 4096 {
			destinationCache.entries[host] = locationEntry{location, time.Now().Add(ttl)}
		}
		destinationCache.Unlock()
		return location, nil
	})
	location, _ := result.(*destinationLocation)
	return location
}

func lookupDestination(ctx context.Context, host string) *destinationLocation {
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil
	}
	var ip netip.Addr
	for _, candidate := range ips {
		candidate = candidate.Unmap()
		if !candidate.IsGlobalUnicast() || candidate.IsPrivate() || candidate.IsLoopback() || candidate.IsLinkLocalUnicast() {
			return nil
		}
		if !ip.IsValid() || candidate.Is4() {
			ip = candidate
		}
	}
	if !ip.IsValid() {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://ipwho.is/"+ip.String(), nil)
	if err != nil {
		return nil
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	var data struct {
		Success bool `json:"success"`
		destinationLocation
	}
	if json.NewDecoder(io.LimitReader(response.Body, 32768)).Decode(&data) != nil || !data.Success || data.Country == "" || data.Latitude < -90 || data.Latitude > 90 || data.Longitude < -180 || data.Longitude > 180 {
		return nil
	}
	data.IP = ip.String()
	return &data.destinationLocation
}

func (s *Server) handleDestinationLocations(w http.ResponseWriter, r *http.Request, a *authCtx) {
	checks, err := s.store.ListChecks(r.Context(), store.CheckFilter{Access: s.access(r)})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	hosts := map[string]bool{}
	for _, check := range checks {
		if host := destinationHost(check.URL); host != "" {
			hosts[host] = true
		}
	}
	if s.settings.Get().ModuleScheduler {
		jobs, err := s.store.ListJobs(r.Context(), store.JobFilter{Access: s.access(r)})
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		for _, job := range jobs {
			if host := destinationHost(job.Config.URL); host != "" {
				hosts[host] = true
			}
		}
	}
	// Return cached results promptly. Bounded workers resolve missing hosts for the next refresh.
	locations := make(map[string]*destinationLocation, len(hosts))
	pending := false
	for host := range hosts {
		destinationCache.Lock()
		cached, ok := destinationCache.entries[host]
		destinationCache.Unlock()
		if ok && time.Now().Before(cached.expires) {
			locations[host] = cached.location
			continue
		}
		locations[host] = nil
		pending = true
		select {
		case destinationCache.slots <- struct{}{}:
			go func() { defer func() { <-destinationCache.slots }(); locateDestination(host) }()
		default:
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"locations": locations, "pending": pending})
}
