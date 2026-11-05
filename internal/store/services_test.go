package store

import (
	"reflect"
	"testing"
)

func TestScopeFilterValid(t *testing.T) {
	for _, f := range []ScopeFilter{"", "-", "7f3a9c2e-1111-4222-8333-944445555666"} {
		if !f.Valid() {
			t.Errorf("%q should be valid", f)
		}
	}
	for _, f := range []ScopeFilter{"backend", "--", "null", "7f3a9c2e"} {
		if f.Valid() {
			t.Errorf("%q should be invalid", f)
		}
	}
}

func TestFilterBuilderScope(t *testing.T) {
	id := "7f3a9c2e-1111-4222-8333-944445555666"
	var b filterBuilder
	b.add("x.project_id = ?", "p1")
	b.scope("x.service_id", "")        // all: no condition
	b.scope("x.service_id", ScopeNone) // none: IS NULL, no argument
	b.scope("x.environment_id", ScopeFilter(id))
	b.add("x.name = ?", "n")

	want := " WHERE x.project_id = $1 AND x.service_id IS NULL AND x.environment_id = $2 AND x.name = $3"
	if got := b.sql(); got != want {
		t.Fatalf("sql:\n got %q\nwant %q", got, want)
	}
	if !reflect.DeepEqual(b.args, []any{"p1", id, "n"}) {
		t.Fatalf("args: %v", b.args)
	}

	var empty filterBuilder
	empty.scope("x.service_id", "")
	if empty.sql() != "" || len(empty.args) != 0 {
		t.Fatal("an all-filter must add nothing")
	}
}

func TestNormalizeServiceKey(t *testing.T) {
	if k, err := NormalizeServiceKey("  Backend-API "); err != nil || k != "backend-api" {
		t.Fatalf("got %q, %v", k, err)
	}
	for _, bad := range []string{"", "a", "1web", "web-", "we b", "-"} {
		if _, err := NormalizeServiceKey(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}
