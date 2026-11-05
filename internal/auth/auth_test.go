package auth

import (
	"testing"
	"time"
)

// RFC 6238 test vectors (SHA-1), truncated to 6 digits.
func TestVerifyTOTP_RFCVectors(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" // base32("12345678901234567890")
	cases := []struct {
		unix int64
		code string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1234567890, "005924"},
	}
	for _, c := range cases {
		step, ok := VerifyTOTP(secret, c.code, 0, time.Unix(c.unix, 0))
		if !ok {
			t.Fatalf("code %s at %d should be valid", c.code, c.unix)
		}
		// Replay of the same step must be rejected.
		if _, ok := VerifyTOTP(secret, c.code, step, time.Unix(c.unix, 0)); ok {
			t.Fatalf("replayed code %s should be rejected", c.code)
		}
	}
	if _, ok := VerifyTOTP(secret, "000000", 0, time.Unix(59, 0)); ok {
		t.Fatal("wrong code accepted")
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse battery", h) {
		t.Fatal("correct password rejected")
	}
	if VerifyPassword("wrong password!", h) {
		t.Fatal("wrong password accepted")
	}
	if VerifyPassword("anything", "") {
		t.Fatal("empty hash must never verify")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if l.Blocked("k") {
			t.Fatalf("blocked too early at %d", i)
		}
		l.Fail("k")
	}
	if !l.Blocked("k") {
		t.Fatal("should be blocked after 3 failures")
	}
	l.Reset("k")
	if l.Blocked("k") {
		t.Fatal("reset should unblock")
	}
}
