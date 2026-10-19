package pake

import (
	"bytes"
	"crypto/sha256"
	"os"
	"testing"
)

func TestSamePasswordSameKey(t *testing.T) {
	a, err := Start(SideA, []byte("4-apple-river"), []byte("dropcode-sender"), []byte("dropcode-receiver"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Start(SideB, []byte("4-apple-river"), []byte("dropcode-sender"), []byte("dropcode-receiver"))
	if err != nil {
		t.Fatal(err)
	}
	ka, err := a.Finish(b.Message())
	if err != nil {
		t.Fatal(err)
	}
	kb, err := b.Finish(a.Message())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ka, kb) || len(ka) != KeyLen {
		t.Fatal("keys differ")
	}
}

func TestWrongPasswordDifferentKey(t *testing.T) {
	a, _ := Start(SideA, []byte("4-apple-river"), []byte("a"), []byte("b"))
	b, _ := Start(SideB, []byte("4-apple-rival"), []byte("a"), []byte("b"))
	ka, _ := a.Finish(b.Message())
	kb, _ := b.Finish(a.Message())
	if bytes.Equal(ka, kb) {
		t.Fatal("different passwords produced the same key")
	}
}

func TestReflectionAndReuseRejected(t *testing.T) {
	a, _ := Start(SideA, []byte("pw"), []byte("a"), []byte("b"))
	if _, err := a.Finish(a.Message()); err == nil {
		t.Fatal("reflected message accepted")
	}
	if _, err := a.Finish(a.Message()); err == nil {
		t.Fatal("state reused")
	}
}

// The embedded module must be the same binary the web client ships.
func TestEmbeddedModuleMatchesShared(t *testing.T) {
	shared, err := os.ReadFile("../../../shared/pake.wasm")
	if err != nil {
		t.Skip("shared/pake.wasm not available:", err)
	}
	if sha256.Sum256(shared) != sha256.Sum256(wasmBytes) {
		t.Fatal("cli/internal/pake/pake.wasm differs from shared/pake.wasm; run scripts/build-pake.sh")
	}
}
