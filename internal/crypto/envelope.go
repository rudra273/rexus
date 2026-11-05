package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

// Envelope encryption for vault secrets (plan.md §6):
//
//	value ──AES-256-GCM(data key)──▶ ciphertext
//	data key ──AES-256-GCM(master key)──▶ wrapped key
//
// Every version of every secret gets its own random data key, and the master
// key never touches the database. aad ties both ciphertexts to one specific
// secret version, so rows can't be swapped around in the database.

func dataAAD(aad []byte) []byte { return append([]byte("rexus:data:"), aad...) }
func keyAAD(aad []byte) []byte  { return append([]byte("rexus:dek:"), aad...) }

// Seal encrypts plaintext with a fresh data key and wraps that key with the
// master key. It returns (ciphertext, wrappedKey).
func (k *Keyring) Seal(plaintext, aad []byte) (ciphertext, wrappedKey []byte, err error) {
	dek := make([]byte, 32)
	if _, err := rand.Read(dek); err != nil {
		return nil, nil, err
	}
	defer clear(dek)

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+gcm.Overhead())
	out = append(out, keyVersion)
	out = append(out, nonce...)
	ciphertext = gcm.Seal(out, nonce, plaintext, dataAAD(aad))

	wrappedKey, err = k.Encrypt(dek, keyAAD(aad))
	if err != nil {
		return nil, nil, err
	}
	return ciphertext, wrappedKey, nil
}

// Open reverses Seal.
func (k *Keyring) Open(ciphertext, wrappedKey, aad []byte) ([]byte, error) {
	dek, err := k.Decrypt(wrappedKey, keyAAD(aad))
	if err != nil {
		return nil, err
	}
	defer clear(dek)

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(ciphertext) < 1+ns+gcm.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	if ciphertext[0] != keyVersion {
		return nil, fmt.Errorf("unknown ciphertext version %d", ciphertext[0])
	}
	pt, err := gcm.Open(nil, ciphertext[1:1+ns], ciphertext[1+ns:], dataAAD(aad))
	if err != nil {
		return nil, errors.New("decryption failed (wrong master key or corrupted data)")
	}
	return pt, nil
}

// NewUUID returns a random (v4) UUID. Secret IDs are generated in the app
// because the ID is part of the encryption context.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
