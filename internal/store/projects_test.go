package store

import "testing"

func TestNormalizeProjectKey(t *testing.T) {
	ok := map[string]string{"acme-web": "acme-web", "Acme-Web": "acme-web", " ab ": "ab", "client-x-api2": "client-x-api2"}
	for in, want := range ok {
		got, err := NormalizeProjectKey(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "a", "1abc", "-abc", "abc-", "ab_c", "a b", "abcdefghijabcdefghijabcdefghijabcdefghijx"} {
		if _, err := NormalizeProjectKey(in); err == nil {
			t.Errorf("%q should be invalid", in)
		}
	}
}
