package server

import (
	"errors"
	"fmt"
	"net/http"
)

// Dashboard settings belong to the whole Rexus instance, not to a person: how the project cards are
// arranged and how dense they are. Everyone who is signed in sees the same thing; only the owner or an
// admin can change it. They live in the key/value settings table under one key.

const dashboardSettingKey = "dashboard"

const (
	dashboardCols     = 12      // the card grid is 12 columns wide
	dashboardMaxCards = 500     // far more than any real instance has; stops junk from piling up
	dashboardMaxRows  = 2000    // tallest card, in grid rows (4px each)
	dashboardMaxY     = 1000000 // lowest row a card can sit on
)

// dashboardPlacement is where one project's card sits, in grid units.
type dashboardPlacement struct {
	X    int  `json:"x"`
	Y    int  `json:"y"`
	W    int  `json:"w"`
	H    int  `json:"h"`
	Auto bool `json:"auto"` // the height follows the card's content; false = the height someone set by hand
}

type dashboardSettings struct {
	Density string                        `json:"density"` // "comfortable" or "compact"
	Layout  map[string]dashboardPlacement `json:"layout"`  // by project id
}

func defaultDashboardSettings() dashboardSettings {
	return dashboardSettings{Density: "comfortable", Layout: map[string]dashboardPlacement{}}
}

// validateDashboardSettings checks what a client sent and returns a clean copy.
func validateDashboardSettings(in dashboardSettings) (dashboardSettings, error) {
	if in.Density != "comfortable" && in.Density != "compact" {
		return dashboardSettings{}, errors.New("density must be comfortable or compact")
	}
	if len(in.Layout) > dashboardMaxCards {
		return dashboardSettings{}, errors.New("too many cards in the layout")
	}
	out := dashboardSettings{Density: in.Density, Layout: make(map[string]dashboardPlacement, len(in.Layout))}
	for id, p := range in.Layout {
		if id == "" || len(id) > 64 {
			return dashboardSettings{}, errors.New("a card has an invalid project id")
		}
		if p.W < 1 || p.X < 0 || p.X+p.W > dashboardCols {
			return dashboardSettings{}, fmt.Errorf("card %q doesn't fit the %d-column grid", id, dashboardCols)
		}
		if p.H < 1 || p.H > dashboardMaxRows || p.Y < 0 || p.Y > dashboardMaxY {
			return dashboardSettings{}, fmt.Errorf("card %q has an invalid position or height", id)
		}
		out.Layout[id] = p
	}
	return out, nil
}

// readDashboardSettings returns what was saved, or the defaults if nothing was.
func (s *Server) readDashboardSettings(r *http.Request) (dashboardSettings, error) {
	cur := defaultDashboardSettings()
	if _, err := s.store.GetSetting(r.Context(), dashboardSettingKey, &cur); err != nil {
		return dashboardSettings{}, err
	}
	if cur.Layout == nil {
		cur.Layout = map[string]dashboardPlacement{}
	}
	return cur, nil
}

func (s *Server) handleGetDashboardSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	cur, err := s.readDashboardSettings(r)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) handlePutDashboardSettings(w http.ResponseWriter, r *http.Request, a *authCtx) {
	if !requireAdmin(w, a) {
		return
	}
	var in dashboardSettings
	if !decodeJSON(w, r, &in) {
		return
	}
	clean, err := validateDashboardSettings(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.SetSetting(r.Context(), dashboardSettingKey, clean); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.audit(r, a, "dashboard.settings", "dashboard", "", map[string]any{"density": clean.Density, "cards": len(clean.Layout)})
	writeJSON(w, http.StatusOK, clean)
}
