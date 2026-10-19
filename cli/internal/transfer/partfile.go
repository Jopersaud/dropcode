package transfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/jopersaud/dropcode/cli/internal/proto"
)

// partFile is a download in progress: "<name>.dropcode-part" holds chunks at
// their final offsets, and "<name>.dropcode-part.json" records which chunks
// are known to be on disk. The sidecar is only rewritten after an fsync of the
// data, so it never claims chunks that a crash could lose.
type partFile struct {
	mu        sync.Mutex
	dir, name string
	meta      proto.FileMeta
	f         *os.File
	have      []bool
	count     int64 // chunks present
	bytes     int64 // bytes present
	dirty     bool
}

type sidecar struct {
	Version int          `json:"version"`
	SHA256  string       `json:"sha256"`
	Size    int64        `json:"size"`
	Have    proto.Ranges `json:"have"`
}

func partPath(dir, name string) string { return filepath.Join(dir, name+".dropcode-part") }

// openPart opens (or resumes) the partial download for meta in dir.
func openPart(dir string, meta proto.FileMeta) (*partFile, error) {
	p := &partFile{dir: dir, name: meta.Name, meta: meta, have: make([]bool, proto.ChunkCount(meta.Size))}
	path := partPath(dir, meta.Name)
	if raw, err := os.ReadFile(path + ".json"); err == nil {
		var sc sidecar
		if json.Unmarshal(raw, &sc) == nil && sc.Version == 1 && sc.SHA256 == meta.SHA256 && sc.Size == meta.Size &&
			proto.CheckRanges(sc.Have, int64(len(p.have))) == nil {
			for _, r := range sc.Have {
				for i := r[0]; i < r[1]; i++ {
					p.mark(i)
				}
			}
		}
	}
	if p.count == 0 {
		_ = os.Remove(path + ".json")
	}
	flags := os.O_RDWR | os.O_CREATE
	if p.count == 0 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	p.f = f
	return p, nil
}

func (p *partFile) chunkLen(i int64) int64 {
	return min(int64(proto.ChunkSize), p.meta.Size-i*proto.ChunkSize)
}

func (p *partFile) mark(i int64) {
	if !p.have[i] {
		p.have[i] = true
		p.count++
		p.bytes += p.chunkLen(i)
	}
}

func (p *partFile) Have() proto.Ranges {
	rs := proto.FromBitmap(func(i int64) bool { return p.have[i] }, int64(len(p.have)))
	if len(rs) > proto.MaxRanges {
		rs = rs[:proto.MaxRanges]
	}
	return rs
}

func (p *partFile) Write(i int64, data []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if i < 0 || i >= int64(len(p.have)) || int64(len(data)) != p.chunkLen(i) {
		return errors.New("bad chunk")
	}
	if p.have[i] {
		return nil
	}
	if _, err := p.f.WriteAt(data, i*proto.ChunkSize); err != nil {
		return err
	}
	p.mark(i)
	p.dirty = true
	return nil
}

// Checkpoint makes the sidecar reflect what is durably on disk.
func (p *partFile) Checkpoint() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.checkpoint()
}

func (p *partFile) checkpoint() error {
	if !p.dirty || p.f == nil {
		return nil
	}
	if err := p.f.Sync(); err != nil {
		return err
	}
	raw, _ := json.Marshal(sidecar{Version: 1, SHA256: p.meta.SHA256, Size: p.meta.Size, Have: p.Have()})
	tmp := partPath(p.dir, p.name) + ".json.tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	p.dirty = false
	return os.Rename(tmp, partPath(p.dir, p.name)+".json")
}

func (p *partFile) Complete() bool { return p.count == int64(len(p.have)) }

// Verify hashes the assembled file.
func (p *partFile) Verify() (bool, error) {
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(p.f, 0, p.meta.Size)); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == p.meta.SHA256, nil
}

// Finish moves the verified file to a name that doesn't overwrite anything.
func (p *partFile) Finish() (string, error) {
	if err := p.f.Truncate(p.meta.Size); err != nil {
		return "", err
	}
	if err := p.f.Sync(); err != nil {
		return "", err
	}
	p.f.Close()
	ext := filepath.Ext(p.name)
	base := strings.TrimSuffix(p.name, ext)
	for n := 0; n < 1000; n++ {
		name := p.name
		if n > 0 {
			name = fmt.Sprintf("%s (%d)%s", base, n, ext)
		}
		dst := filepath.Join(p.dir, name)
		// Link-then-remove refuses to clobber an existing file, unlike rename.
		if err := os.Link(partPath(p.dir, p.name), dst); err == nil {
			_ = os.Remove(partPath(p.dir, p.name))
			_ = os.Remove(partPath(p.dir, p.name) + ".json")
			return dst, nil
		} else if !errors.Is(err, os.ErrExist) {
			// Filesystems without hard links: fall back to a checked rename.
			if _, statErr := os.Lstat(dst); errors.Is(statErr, os.ErrNotExist) {
				if err := os.Rename(partPath(p.dir, p.name), dst); err != nil {
					return "", err
				}
				_ = os.Remove(partPath(p.dir, p.name) + ".json")
				return dst, nil
			}
		}
	}
	return "", errors.New("could not find a free file name")
}

// Discard removes a corrupt download.
func (p *partFile) Discard() {
	p.f.Close()
	_ = os.Remove(partPath(p.dir, p.name))
	_ = os.Remove(partPath(p.dir, p.name) + ".json")
}

func (p *partFile) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.f == nil {
		return
	}
	_ = p.checkpoint()
	p.f.Close()
	p.f = nil
}
