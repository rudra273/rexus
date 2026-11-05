package auth

import (
	"sync"
	"time"
)

// Limiter blocks a key (IP or email) after too many failures in a window.
// In-memory is enough: Rexus runs as a single instance.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	m      map[string]*limitEntry
}

type limitEntry struct {
	count int
	first time.Time
}

func NewLimiter(max int, window time.Duration) *Limiter {
	return &Limiter{max: max, window: window, m: make(map[string]*limitEntry)}
}

// Blocked reports whether key has reached the failure limit.
func (l *Limiter) Blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.m[key]
	if !ok {
		return false
	}
	if time.Since(e.first) > l.window {
		delete(l.m, key)
		return false
	}
	return e.count >= l.max
}

// Fail records a failure for key.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.m[key]
	if !ok || time.Since(e.first) > l.window {
		l.m[key] = &limitEntry{count: 1, first: time.Now()}
		return
	}
	e.count++
	// Opportunistic cleanup so the map can't grow forever.
	if len(l.m) > 10_000 {
		for k, v := range l.m {
			if time.Since(v.first) > l.window {
				delete(l.m, k)
			}
		}
	}
}

// Reset clears failures for key (after a successful login).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.m, key)
}
