// Package scheduler runs cron jobs. State (next run, history) lives in the
// database, so restarts are safe and missed runs are caught up once.
package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"rexus/internal/alerts"
	"rexus/internal/crypto"
	"rexus/internal/store"
)

const (
	pollInterval   = 5 * time.Second
	maxConcurrent  = 10
	runRetention   = 30 * 24 * time.Hour
	snippetMaxSize = 500
	userAgent      = "Rexus-Scheduler/1.0"
)

// HeadersAAD binds encrypted job headers to their purpose.
var HeadersAAD = []byte("rexus:job-headers")

type Engine struct {
	store  *store.Store
	keys   *crypto.Keyring
	log    *slog.Logger
	alerts *alerts.Service
	// userJobs says whether user-defined jobs should run right now. The scheduler module can be switched on and
	// off while Rexus runs, so it is asked on every tick. Health checks run either way.
	userJobs func() bool

	client *http.Client
	sem    chan struct{}
	wg     sync.WaitGroup
}

func New(st *store.Store, keys *crypto.Keyring, log *slog.Logger, userJobs func() bool, al *alerts.Service) *Engine {
	return &Engine{
		store:    st,
		keys:     keys,
		log:      log,
		alerts:   al,
		userJobs: userJobs,
		client:   &http.Client{}, // per-request timeout comes from the job's context
		sem:      make(chan struct{}, maxConcurrent),
	}
}

// Start runs the scheduler loop until ctx is cancelled.
func (e *Engine) Start(ctx context.Context) {
	if n, err := e.store.FailStaleRuns(ctx); err != nil {
		e.log.Error("scheduler: fail stale runs", "err", err)
	} else if n > 0 {
		e.log.Warn("scheduler: marked interrupted runs as failed", "count", n)
	}

	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		poll := time.NewTicker(pollInterval)
		defer poll.Stop()
		prune := time.NewTicker(time.Hour)
		defer prune.Stop()

		e.housekeeping(ctx)
		e.tickAll(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-poll.C:
				e.tickAll(ctx)
			case <-prune.C:
				e.housekeeping(ctx)
			}
		}
	}()
	if e.userJobs() {
		e.log.Info("scheduler started", "poll", pollInterval.String())
	} else {
		e.log.Info("scheduler: user jobs are switched off (Settings → Modules, or REXUS_MODULE_SCHEDULER=false); health checks still run")
	}
}

// Wait blocks until the loop and all in-flight runs finish (or timeout).
func (e *Engine) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() { e.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		e.log.Warn("scheduler: shutdown timed out with runs still in progress")
	}
}

// tickAll runs everything that is due. Health checks are system jobs and
// always run; user cron jobs run only while the scheduler module is on.
func (e *Engine) tickAll(ctx context.Context) {
	if e.userJobs() {
		e.tick(ctx)
	}
	e.tickHealth(ctx)
}

func (e *Engine) housekeeping(ctx context.Context) {
	if err := e.store.PruneRuns(ctx, runRetention); err != nil {
		e.log.Error("scheduler: prune runs", "err", err)
	}
	if err := e.store.PruneHealthResults(ctx, healthRetention); err != nil {
		e.log.Error("scheduler: prune health results", "err", err)
	}
	if err := e.store.PruneSessions(ctx); err != nil {
		e.log.Error("scheduler: prune sessions", "err", err)
	}
}

func (e *Engine) tick(ctx context.Context) {
	jobs, err := e.store.ClaimDueJobs(ctx, 20, func(schedule string) (*time.Time, error) {
		n, err := Next(schedule, time.Now())
		return &n, err
	})
	if err != nil {
		if ctx.Err() == nil {
			e.log.Error("scheduler: claim due jobs", "err", err)
		}
		return
	}
	for _, j := range jobs {
		runID, err := e.store.CreateRun(ctx, j.ID, "schedule")
		if err != nil {
			e.log.Error("scheduler: create run", "job", j.ID, "err", err)
			continue
		}
		e.launch(j, runID)
	}
}

// RunNow starts a manual run immediately and returns its run ID.
func (e *Engine) RunNow(ctx context.Context, j *store.Job) (string, error) {
	runID, err := e.store.CreateRun(ctx, j.ID, "manual")
	if err != nil {
		return "", err
	}
	e.launch(j, runID)
	return runID, nil
}

func (e *Engine) launch(j *store.Job, runID string) {
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		e.sem <- struct{}{}
		defer func() { <-e.sem }()
		// Runs use their own context so a shutdown lets in-flight runs finish
		// (bounded by the job's timeout) instead of recording a false failure.
		e.execute(context.Background(), j, runID)
	}()
}

func (e *Engine) execute(ctx context.Context, j *store.Job, runID string) {
	start := time.Now()
	run := &store.JobRun{ID: runID, JobID: j.ID}

	headers, err := e.decryptHeaders(j)
	var code int
	var snippet string
	if err == nil {
		for attempt := 1; attempt <= j.Retries+1; attempt++ {
			run.Attempts = attempt
			code, snippet, err = e.doHTTP(ctx, j, headers)
			if err == nil {
				break
			}
			if attempt <= j.Retries {
				time.Sleep(time.Duration(attempt) * 2 * time.Second)
			}
		}
	}

	dur := int(time.Since(start).Milliseconds())
	run.DurationMS = &dur
	if code != 0 {
		run.StatusCode = &code
	}
	if snippet != "" {
		run.ResponseSnippet = &snippet
	}
	if err != nil {
		run.Status = "failed"
		msg := err.Error()
		run.Error = &msg
		e.log.Warn("job failed", "job", j.Name, "id", j.ID, "attempts", run.Attempts, "err", msg)
	} else {
		run.Status = "success"
		e.log.Debug("job succeeded", "job", j.Name, "id", j.ID, "status", code, "ms", dur)
	}
	prev, ferr := e.store.FinishRun(context.Background(), run)
	if ferr != nil {
		e.log.Error("scheduler: finish run", "run", runID, "err", ferr)
		return
	}
	// One alert when a job starts failing — not on every failed run after that.
	if run.Status == "failed" && (prev == nil || *prev != "failed") {
		e.alerts.JobFailed(j, run)
	}
}

func (e *Engine) decryptHeaders(j *store.Job) (map[string]string, error) {
	if len(j.HeadersEnc) == 0 {
		return nil, nil
	}
	pt, err := e.keys.Decrypt(j.HeadersEnc, HeadersAAD)
	if err != nil {
		return nil, fmt.Errorf("could not decrypt request headers: %w", err)
	}
	var h map[string]string
	if err := json.Unmarshal(pt, &h); err != nil {
		return nil, fmt.Errorf("could not read request headers: %w", err)
	}
	return h, nil
}

// doHTTP performs one attempt. It returns the status code (0 if no response),
// a short response snippet, and an error if the request failed or the status
// didn't match the expected range.
func (e *Engine) doHTTP(ctx context.Context, j *store.Job, headers map[string]string) (int, string, error) {
	ranges, err := ParseExpectedStatus(j.Config.ExpectedStatus)
	if err != nil {
		return 0, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(j.TimeoutSeconds)*time.Second)
	defer cancel()

	method := j.Config.Method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if j.Config.Body != "" {
		body = strings.NewReader(j.Config.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, j.Config.URL, body)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := e.client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return 0, "", fmt.Errorf("timeout after %ds", j.TimeoutSeconds)
		}
		return 0, "", err
	}
	defer resp.Body.Close()

	buf, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20)) // drain a little so the connection can be reused
	snippet := truncate(strings.ToValidUTF8(string(buf), ""), snippetMaxSize)

	if !statusMatches(resp.StatusCode, ranges) {
		return resp.StatusCode, snippet, fmt.Errorf("unexpected status %d (expected %s)", resp.StatusCode, j.Config.ExpectedStatus)
	}
	return resp.StatusCode, snippet, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}
