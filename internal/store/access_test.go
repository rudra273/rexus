package store

import (
	"reflect"
	"strings"
	"testing"
)

func TestAccessConditions(t *testing.T) {
	// The zero Access (the owner, or Rexus itself) adds no condition at all.
	var open filterBuilder
	open.access("s.project_id", Access{})
	if open.sql() != "" || len(open.args) != 0 {
		t.Fatalf("unrestricted access must not filter: %q %v", open.sql(), open.args)
	}

	// A viewer is filtered by the one visibility rule, with their ID as the single argument.
	var b filterBuilder
	b.add("s.name = ?", "x")
	b.access("s.project_id", Access{Viewer: "7f3a9c2e-1111-4222-8333-944445555666"})
	got := b.sql()
	if !strings.Contains(got, "s.project_id IN (SELECT pv.id FROM projects pv") || strings.Contains(got, "?") {
		t.Fatalf("unexpected sql: %s", got)
	}
	if !strings.Contains(got, "pa.user_id = $2") || !strings.Contains(got, "vu.id = $2") {
		t.Fatalf("both uses of the viewer must share one argument: %s", got)
	}
	if !reflect.DeepEqual(b.args, []any{"x", "7f3a9c2e-1111-4222-8333-944445555666"}) {
		t.Fatalf("args: %v", b.args)
	}

	// An API token limited to chosen projects adds an ANY() condition on top.
	var tok filterBuilder
	tok.access("c.project_id", Access{Viewer: NoOne, Only: []string{"a", "b"}})
	if !strings.Contains(tok.sql(), "c.project_id = ANY($2::uuid[])") || len(tok.args) != 2 {
		t.Fatalf("token limit: %s %v", tok.sql(), tok.args)
	}
	// "Limited to nothing" (an empty, non-nil list) is not the same as "not limited".
	var none filterBuilder
	none.access("c.project_id", Access{Only: []string{}})
	if !strings.Contains(none.sql(), "ANY(") {
		t.Fatalf("an empty limit must still filter: %q", none.sql())
	}
}
