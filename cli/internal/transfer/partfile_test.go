package transfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/jopersaud/dropcode/cli/internal/proto"
)

func TestPartFileResumeAndFinish(t *testing.T) {
	dir := t.TempDir()
	data := bytes.Repeat([]byte("dropcode"), 3*proto.ChunkSize/8+100) // 3 full chunks + a partial one
	sum := sha256.Sum256(data)
	meta := proto.FileMeta{Name: "f.bin", Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), ChunkSize: proto.ChunkSize}
	chunk := func(i int64) []byte { return data[i*proto.ChunkSize : min(int64(len(data)), (i+1)*proto.ChunkSize)] }

	p, err := openPart(dir, meta)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range []int64{0, 1, 3} {
		if err := p.Write(i, chunk(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.Write(2, []byte("short")); err == nil {
		t.Fatal("accepted a chunk of the wrong length")
	}
	p.Close()

	p, _ = openPart(dir, meta)
	if got := p.Have(); len(got) != 2 || got[0] != (proto.Range{0, 2}) || got[1] != (proto.Range{3, 4}) {
		t.Fatalf("resumed have = %v", got)
	}
	p.Close()

	// A different file with the same name must not resume from this state
	// (and replaces it).
	other := meta
	other.SHA256 = "00" + meta.SHA256[2:]
	q, _ := openPart(dir, other)
	if len(q.Have()) != 0 {
		t.Fatal("resumed state of a different file")
	}
	q.Close()

	p, _ = openPart(dir, meta)
	for i := int64(0); i < 4; i++ {
		_ = p.Write(i, chunk(i))
	}
	p.Close()
	p, _ = openPart(dir, meta)
	if got := p.Have(); len(got) != 1 || got[0] != (proto.Range{0, 4}) || !p.Complete() {
		t.Fatalf("have = %v", got)
	}
	if ok, err := p.Verify(); !ok || err != nil {
		t.Fatal("verify failed", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "f.bin"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := p.Finish()
	if err != nil || filepath.Base(path) != "f (1).bin" {
		t.Fatal("finish:", path, err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, data) {
		t.Fatal("content mismatch")
	}
	if old, _ := os.ReadFile(filepath.Join(dir, "f.bin")); string(old) != "existing" {
		t.Fatal("existing file was overwritten")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("leftover files: %v", entries)
	}
}
