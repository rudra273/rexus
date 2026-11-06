package server

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"rexus/internal/alerts"
	"rexus/internal/store"
)

const maxChannels = 20

// channelView is a channel as the UI sees it: the settings are summarised,
// never returned (bot tokens and webhook URLs are secrets).
type channelView struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) channelView(ch *store.AlertChannel) channelView {
	v := channelView{ID: ch.ID, Type: ch.Type, Name: ch.Name, Enabled: ch.Enabled, CreatedAt: ch.CreatedAt}
	if cfg, err := s.alerts.DecryptConfig(ch.ConfigEnc); err != nil {
		v.Summary = "unreadable — was REXUS_MASTER_KEY changed?"
	} else {
		v.Summary = cfg.Summary(ch.Type)
	}
	return v
}

func (s *Server) loadChannel(w http.ResponseWriter, r *http.Request) (*store.AlertChannel, bool) {
	id := r.PathValue("id")
	if !store.IsUUID(id) {
		writeError(w, http.StatusNotFound, "channel not found")
		return nil, false
	}
	ch, err := s.store.AlertChannelByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "channel not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return ch, true
}

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	channels, err := s.store.ListAlertChannels(r.Context(), false)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	views := make([]channelView, 0, len(channels))
	for _, ch := range channels {
		views = append(views, s.channelView(ch))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"channels":        views,
		"smtp_configured": s.alerts.SMTPConfigured(),
		"smtp_host":       s.alerts.SMTPHost(),
	})
}

type channelInput struct {
	Type    string        `json:"type"`
	Name    string        `json:"name"`
	Enabled *bool         `json:"enabled"`
	Config  alerts.Config `json:"config"`
}

func validChannelName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := len([]rune(name)); n < 1 || n > 60 {
		return "", errors.New("name must be 1–60 characters")
	}
	return name, nil
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in channelInput
	if !decodeJSON(w, r, &in) {
		return
	}
	name, err := validChannelName(in.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := in.Config.Validate(in.Type, s.alerts.SMTPConfigured()); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if n, err := s.store.CountAlertChannels(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	} else if n >= maxChannels {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d channels", maxChannels))
		return
	}
	enc, err := s.alerts.EncryptConfig(&in.Config)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	enabled := in.Enabled == nil || *in.Enabled
	ch, err := s.store.CreateAlertChannel(r.Context(), in.Type, name, enc, enabled, a.user.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "alert.channel_create", "alert_channel", ch.ID, map[string]any{"name": ch.Name, "type": ch.Type})
	writeJSON(w, http.StatusCreated, map[string]any{"channel": s.channelView(ch)})
}

// handleUpdateChannel changes the name, on/off and — when given — the settings.
// Blank secret fields keep the stored secret, so they never have to be re-entered.
func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	ch, ok := s.loadChannel(w, r)
	if !ok {
		return
	}
	var in channelInput
	if !decodeJSON(w, r, &in) {
		return
	}
	name := ch.Name
	if strings.TrimSpace(in.Name) != "" {
		var err error
		if name, err = validChannelName(in.Name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	enabled := ch.Enabled
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	var enc []byte
	if !in.Config.IsEmpty() {
		old, err := s.alerts.DecryptConfig(ch.ConfigEnc)
		if err != nil {
			old = &alerts.Config{}
		}
		cfg := in.Config
		if cfg.BotToken == "" {
			cfg.BotToken = old.BotToken
		}
		if cfg.WebhookURL == "" {
			cfg.WebhookURL = old.WebhookURL
		}
		if cfg.ChatID == "" {
			cfg.ChatID = old.ChatID
		}
		if len(cfg.To) == 0 {
			cfg.To = old.To
		}
		if err := cfg.Validate(ch.Type, s.alerts.SMTPConfigured()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if enc, err = s.alerts.EncryptConfig(&cfg); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	updated, err := s.store.UpdateAlertChannel(r.Context(), ch.ID, name, enc, enabled)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "alert.channel_update", "alert_channel", ch.ID, map[string]any{"name": updated.Name, "enabled": enabled, "settings_changed": enc != nil})
	writeJSON(w, http.StatusOK, map[string]any{"channel": s.channelView(updated)})
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	ch, ok := s.loadChannel(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteAlertChannel(r.Context(), ch.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "alert.channel_delete", "alert_channel", ch.ID, map[string]any{"name": ch.Name, "type": ch.Type})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleTestChannel(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	ch, ok := s.loadChannel(w, r)
	if !ok {
		return
	}
	err := s.alerts.Test(r.Context(), ch)
	s.audit(r, a, "alert.channel_test", "alert_channel", ch.ID, map[string]any{"name": ch.Name, "ok": err == nil})
	if err != nil {
		// A failed test is an answer, not a server fault.
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- events ----

type eventView struct {
	alerts.EventDef
	Enabled bool  `json:"enabled"`
	Days    []int `json:"days,omitempty"`
}

func (s *Server) handleListAlertEvents(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	settings, err := s.store.AlertEventSettings(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]eventView, 0, len(alerts.Events))
	for _, def := range alerts.Events {
		if def.Key == alerts.EventBackupFailed && !s.settings.Get().BackupEnabled {
			continue // nothing to alert on until backups are switched on
		}
		v := eventView{EventDef: def, Enabled: def.DefaultEnabled}
		if st, ok := settings[def.Key]; ok {
			v.Enabled = st.Enabled
		}
		if def.HasDays {
			v.Days = s.alerts.ReminderDays(r.Context())
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

func (s *Server) handleUpdateAlertEvent(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	def, ok := alerts.EventByKey(r.PathValue("key"))
	if !ok {
		writeError(w, http.StatusNotFound, "unknown alert event")
		return
	}
	var in struct {
		Enabled bool  `json:"enabled"`
		Days    []int `json:"days"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	options := map[string]any{}
	if def.HasDays {
		seen := map[int]bool{}
		days := []int{}
		for _, d := range in.Days {
			if d < 1 || d > 365 {
				writeError(w, http.StatusBadRequest, "reminder days must be between 1 and 365")
				return
			}
			if !seen[d] {
				seen[d] = true
				days = append(days, d)
			}
		}
		if len(days) == 0 || len(days) > 6 {
			writeError(w, http.StatusBadRequest, "choose 1–6 reminder days")
			return
		}
		sort.Sort(sort.Reverse(sort.IntSlice(days)))
		options["days"] = days
	}
	if err := s.store.SetAlertEvent(r.Context(), def.Key, in.Enabled, options); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "alert.event_update", "alert_event", def.Key, map[string]any{"enabled": in.Enabled, "options": options})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAlertHistory(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	limit := 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	recs, err := s.store.ListAlertRecords(r.Context(), limit, s.access(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": recs})
}
