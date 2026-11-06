package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateDashboardSettings(t *testing.T) {
	card := func(x, y, w, h int) dashboardPlacement { return dashboardPlacement{X: x, Y: y, W: w, H: h, Auto: true} }
	many := map[string]dashboardPlacement{}
	for i := 0; i <= dashboardMaxCards; i++ {
		many[strings.Repeat("a", 5)+string(rune('A'+i%26))+strings.Repeat("b", i/26)] = card(0, 0, 6, 5)
	}

	cases := []struct {
		name string
		in   dashboardSettings
		ok   bool
	}{
		{"empty layout", dashboardSettings{Density: "comfortable"}, true},
		{"compact with cards", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(0, 0, 6, 9), "p2": card(6, 0, 6, 9)}}, true},
		{"full width card", dashboardSettings{Density: "comfortable", Layout: map[string]dashboardPlacement{"p1": card(0, 0, 12, 5)}}, true},
		{"unknown density", dashboardSettings{Density: "tiny"}, false},
		{"no density", dashboardSettings{}, false},
		{"runs off the right edge", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(8, 0, 6, 5)}}, false},
		{"zero width", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(0, 0, 0, 5)}}, false},
		{"negative position", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(-1, 0, 6, 5)}}, false},
		{"zero height", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(0, 0, 6, 0)}}, false},
		{"absurd height", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": card(0, 0, 6, dashboardMaxRows+1)}}, false},
		{"empty project id", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"": card(0, 0, 6, 5)}}, false},
		{"huge project id", dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{strings.Repeat("x", 65): card(0, 0, 6, 5)}}, false},
		{"too many cards", dashboardSettings{Density: "compact", Layout: many}, false},
	}
	for _, c := range cases {
		out, err := validateDashboardSettings(c.in)
		if c.ok && err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: expected an error", c.name)
		}
		if c.ok && out.Layout == nil {
			t.Errorf("%s: a valid result must have a non-nil layout (it is sent to the browser as {})", c.name)
		}
	}
}

// What is stored must read back the same, and an old or partial value must fall back to the defaults.
func TestDashboardSettingsJSON(t *testing.T) {
	in := dashboardSettings{Density: "compact", Layout: map[string]dashboardPlacement{"p1": {X: 6, Y: 2, W: 4, H: 7, Auto: false}}}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out := defaultDashboardSettings()
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Density != "compact" || out.Layout["p1"] != in.Layout["p1"] {
		t.Fatalf("round trip changed the settings: %+v", out)
	}

	partial := defaultDashboardSettings()
	if err := json.Unmarshal([]byte(`{"layout":{}}`), &partial); err != nil {
		t.Fatal(err)
	}
	if partial.Density != "comfortable" {
		t.Fatalf("a value without a density should keep the default, got %q", partial.Density)
	}
}
