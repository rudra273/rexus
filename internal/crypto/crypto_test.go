package crypto

import (
	"bytes"
	"testing"
)

func testKeyring(t *testing.T) *Keyring {
	t.Helper()
	key, err := ParseMasterKey(GenerateMasterKey())
	if err != nil {
		t.Fatal(err)
	}
	k, err := NewKeyring(key)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestEncryptDecrypt(t *testing.T) {
	k := testKeyring(t)
	blob, err := k.Encrypt([]byte("hello"), []byte("ctx"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("hello")) {
		t.Fatal("plaintext visible in ciphertext")
	}
	pt, err := k.Decrypt(blob, []byte("ctx"))
	if err != nil || string(pt) != "hello" {
		t.Fatalf("round trip failed: %q %v", pt, err)
	}
	if _, err := k.Decrypt(blob, []byte("other")); err == nil {
		t.Fatal("wrong context must fail")
	}
	if _, err := testKeyring(t).Decrypt(blob, []byte("ctx")); err == nil {
		t.Fatal("wrong master key must fail")
	}
}

func TestSealOpen(t *testing.T) {
	k := testKeyring(t)
	aad := []byte("rexus:secret:abc:v1")
	ct, wrapped, err := k.Seal([]byte("sk_live_12345"), aad)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ct, []byte("sk_live")) || bytes.Contains(wrapped, []byte("sk_live")) {
		t.Fatal("plaintext visible")
	}
	pt, err := k.Open(ct, wrapped, aad)
	if err != nil || string(pt) != "sk_live_12345" {
		t.Fatalf("round trip failed: %q %v", pt, err)
	}
	// Same value sealed twice must differ (fresh data key + nonce each time).
	ct2, _, _ := k.Seal([]byte("sk_live_12345"), aad)
	if bytes.Equal(ct, ct2) {
		t.Fatal("ciphertexts must differ")
	}
	// Bound to its version: another version's context must not open it.
	if _, err := k.Open(ct, wrapped, []byte("rexus:secret:abc:v2")); err == nil {
		t.Fatal("wrong aad must fail")
	}
	// Swapping the wrapped key from another secret must fail.
	_, wrapped2, _ := k.Seal([]byte("other"), aad)
	if _, err := k.Open(ct, wrapped2, aad); err == nil {
		t.Fatal("mismatched wrapped key must fail")
	}
	// Tampering must fail.
	bad := append([]byte(nil), ct...)
	bad[len(bad)-1] ^= 1
	if _, err := k.Open(bad, wrapped, aad); err == nil {
		t.Fatal("tampered ciphertext must fail")
	}
}

func TestNewUUID(t *testing.T) {
	a, b := NewUUID(), NewUUID()
	if a == b || len(a) != 36 || a[14] != '4' {
		t.Fatalf("bad uuids: %s %s", a, b)
	}
}
