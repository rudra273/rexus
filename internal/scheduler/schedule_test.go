package scheduler

import "testing"

func TestValidate(t *testing.T) {
	ok := []string{"*/5 * * * *", "@hourly", "@daily", "@every 10m", "0 9 */3 * *", "CRON_TZ=Asia/Kolkata 0 9 * * *"}
	for _, s := range ok {
		if err := Validate(s); err != nil {
			t.Errorf("%q should be valid: %v", s, err)
		}
	}
	bad := []string{"", "nope", "* * *", "@every 10s", "61 * * * *"}
	for _, s := range bad {
		if err := Validate(s); err == nil {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestExpectedStatus(t *testing.T) {
	r, err := ParseExpectedStatus("200,204,301-302")
	if err != nil {
		t.Fatal(err)
	}
	for code, want := range map[int]bool{200: true, 204: true, 301: true, 302: true, 201: false, 500: false} {
		if got := statusMatches(code, r); got != want {
			t.Errorf("status %d: got %v want %v", code, got, want)
		}
	}
	if r, _ := ParseExpectedStatus(""); !statusMatches(299, r) || statusMatches(300, r) {
		t.Error("empty spec should default to 200-299")
	}
	for _, s := range []string{"abc", "99", "300-200", "200-700"} {
		if _, err := ParseExpectedStatus(s); err == nil {
			t.Errorf("%q should be invalid", s)
		}
	}
}
