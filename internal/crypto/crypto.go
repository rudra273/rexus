// Package crypto holds the small set of crypto helpers Rexus uses.
// Only standard primitives: AES-256-GCM, SHA-256, crypto/rand.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const keyVersion byte = 1

// Keyring encrypts small values (TOTP secrets, job headers) with the master key.
// Phase 2 (vault) adds per-secret data keys wrapped by this same master key.
type Keyring struct {
	aead cipher.AEAD
}

func NewKeyring(masterKey []byte) (*Keyring, error) {
	if len(masterKey) != 32 {
		return nil, errors.New("master key must be 32 bytes")
	}
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Keyring{aead: aead}, nil
}

// Encrypt returns version || nonce || ciphertext. aad binds the ciphertext to
// its context (e.g. "totp:<user-id>") so it can't be swapped between rows.
func (k *Keyring) Encrypt(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+k.aead.Overhead())
	out = append(out, keyVersion)
	out = append(out, nonce...)
	return k.aead.Seal(out, nonce, plaintext, aad), nil
}

func (k *Keyring) Decrypt(blob, aad []byte) ([]byte, error) {
	ns := k.aead.NonceSize()
	if len(blob) < 1+ns+k.aead.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	if blob[0] != keyVersion {
		return nil, fmt.Errorf("unknown ciphertext version %d", blob[0])
	}
	nonce := blob[1 : 1+ns]
	pt, err := k.aead.Open(nil, nonce, blob[1+ns:], aad)
	if err != nil {
		return nil, errors.New("decryption failed (wrong master key or corrupted data)")
	}
	return pt, nil
}

// ParseMasterKey accepts a 32-byte key encoded as base64 (std or URL, with or
// without padding) or as 64 hex characters.
func ParseMasterKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if len(s) == 64 {
		if b, err := hex.DecodeString(s); err == nil {
			return b, nil
		}
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			if len(b) != 32 {
				return nil, fmt.Errorf("must decode to 32 bytes, got %d — generate one with: rexus keygen", len(b))
			}
			return b, nil
		}
	}
	return nil, errors.New("must be base64 or hex — generate one with: rexus keygen")
}

// GenerateMasterKey returns a new random 32-byte key, base64 encoded.
func GenerateMasterKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// RandomToken returns n random bytes, base64url encoded (no padding).
func RandomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// HashToken hashes a session/invite token for storage. Tokens are high-entropy
// random values, so a plain SHA-256 is appropriate (no slow hash needed).
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
