// Package proto mirrors web/src/peer-protocol.ts: the messages peers exchange
// over the WebRTC data channel, with the same strict validation.
package proto

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	Version         = 1
	ChunkSize       = 64 * 1024
	MaxControlBytes = 64 * 1024
	MaxNameBytes    = 255
	MaxMimeLength   = 100
	MaxFileSize     = int64(1) << 40
	MaxRanges       = 4096
)

type FileMeta struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Mime      string `json:"mime"`
	SHA256    string `json:"sha256"`
	ChunkSize int    `json:"chunkSize"`
}

// Range is a half-open [Start, End) range of chunk indices.
type Range [2]int64
type Ranges []Range

type Message struct {
	T    string
	V    int
	Msg  string // pake
	Mac  string // confirm
	Meta FileMeta
	Have Ranges
}

func ChunkCount(size int64) int64 { return (size + ChunkSize - 1) / ChunkSize }

var (
	b64RE  = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`) // length is capped separately
	shaRE  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	mimeRE = regexp.MustCompile(`^[\w.+-]+/[\w.+-]+$`)
	ctrlRE = regexp.MustCompile(`[\x00-\x1f\x7f-\x{9f}]`)
	badRE  = regexp.MustCompile(`[<>:"|?*]`)
)

var ErrInvalid = errors.New("invalid peer message")

// SanitizeName makes a received name safe to use as a file name: no path
// components or control characters, at most 255 UTF-8 bytes.
func SanitizeName(raw string) string {
	name := ctrlRE.ReplaceAllString(norm.NFC.String(strings.ToValidUTF8(raw, "")), "")
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimLeft(name, ". \t")
	name = strings.TrimRight(name, ". \t")
	name = badRE.ReplaceAllString(name, "_")
	for len(name) > MaxNameBytes {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" {
		return "download"
	}
	return name
}

func ValidMime(m string) string {
	if len(m) <= MaxMimeLength && mimeRE.MatchString(m) {
		return m
	}
	return "application/octet-stream"
}

func onlyKeys(m map[string]json.RawMessage, keys ...string) bool {
	for k := range m {
		ok := false
		for _, want := range keys {
			if k == want {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func str(m map[string]json.RawMessage, k string) (string, bool) {
	var s string
	raw, ok := m[k]
	if !ok || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// integer accepts only JSON numbers that are exact integers.
func integer(m map[string]json.RawMessage, k string) (int64, bool) {
	var f float64
	raw, ok := m[k]
	if !ok || json.Unmarshal(raw, &f) != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
		return 0, false
	}
	return int64(f), true
}

// Parse validates a JSON control frame from the peer.
func Parse(raw []byte) (*Message, error) {
	if len(raw) > MaxControlBytes {
		return nil, ErrInvalid
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, ErrInvalid
	}
	t, ok := str(m, "t")
	if !ok {
		return nil, ErrInvalid
	}
	out := &Message{T: t}
	switch t {
	case "hello":
		v, ok := integer(m, "v")
		if !onlyKeys(m, "t", "v") || !ok {
			return nil, ErrInvalid
		}
		out.V = int(v)
	case "pake", "confirm":
		key := map[string]string{"pake": "msg", "confirm": "mac"}[t]
		v, ok := str(m, key)
		if !onlyKeys(m, "t", key) || !ok || len(v) > 1024 || !b64RE.MatchString(v) {
			return nil, ErrInvalid
		}
		out.Msg, out.Mac = v, v
	case "meta":
		if !onlyKeys(m, "t", "name", "size", "mime", "sha256", "chunkSize") {
			return nil, ErrInvalid
		}
		name, ok1 := str(m, "name")
		size, ok2 := integer(m, "size")
		sha, ok3 := str(m, "sha256")
		cs, ok4 := integer(m, "chunkSize")
		mime, _ := str(m, "mime")
		if !ok1 || !ok2 || !ok3 || !ok4 || len(name) > 4*MaxNameBytes || size < 0 || size > MaxFileSize ||
			!shaRE.MatchString(sha) || cs != ChunkSize {
			return nil, ErrInvalid
		}
		out.Meta = FileMeta{Name: SanitizeName(name), Size: size, Mime: ValidMime(mime), SHA256: sha, ChunkSize: ChunkSize}
	case "resume":
		if !onlyKeys(m, "t", "have") {
			return nil, ErrInvalid
		}
		var have [][]json.Number
		dec := json.NewDecoder(strings.NewReader(string(m["have"])))
		dec.UseNumber()
		if err := dec.Decode(&have); err != nil || len(have) > MaxRanges {
			return nil, ErrInvalid
		}
		for _, r := range have {
			if len(r) != 2 {
				return nil, ErrInvalid
			}
			a, err1 := r[0].Int64()
			b, err2 := r[1].Int64()
			if err1 != nil || err2 != nil {
				return nil, ErrInvalid
			}
			out.Have = append(out.Have, Range{a, b})
		}
	case "eof", "ok", "hash_mismatch", "cancel":
		if !onlyKeys(m, "t") {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	return out, nil
}

// CheckRanges validates resume ranges against the file's chunk count.
func CheckRanges(rs Ranges, total int64) error {
	var prev int64
	for _, r := range rs {
		if r[0] < prev || r[1] <= r[0] || r[1] > total {
			return fmt.Errorf("bad resume range %v", r)
		}
		prev = r[1]
	}
	return nil
}

// Missing is the complement of have within [0, total).
func Missing(have Ranges, total int64) Ranges {
	var out Ranges
	var cur int64
	for _, r := range have {
		if r[0] > cur {
			out = append(out, Range{cur, r[0]})
		}
		cur = max(cur, r[1])
	}
	if cur < total {
		out = append(out, Range{cur, total})
	}
	return out
}

// FromBitmap compresses a presence bitmap into sorted ranges.
func FromBitmap(has func(int64) bool, total int64) Ranges {
	var out Ranges
	start := int64(-1)
	for i := int64(0); i < total; i++ {
		if has(i) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			out = append(out, Range{start, i})
			start = -1
		}
	}
	if start >= 0 {
		out = append(out, Range{start, total})
	}
	return out
}

func (rs Ranges) Count() int64 {
	var n int64
	for _, r := range rs {
		n += r[1] - r[0]
	}
	return n
}

func encode(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Constructors produce exactly the keys the web client accepts.
func Hello() []byte            { return encode(map[string]any{"t": "hello", "v": Version}) }
func Pake(b64 string) []byte   { return encode(map[string]any{"t": "pake", "msg": b64}) }
func Confirm(b64 string) []byte { return encode(map[string]any{"t": "confirm", "mac": b64}) }
func Simple(t string) []byte   { return encode(map[string]any{"t": t}) }
func Meta(m FileMeta) []byte {
	return encode(map[string]any{"t": "meta", "name": m.Name, "size": m.Size, "mime": m.Mime, "sha256": m.SHA256, "chunkSize": m.ChunkSize})
}
func Resume(have Ranges) []byte {
	if have == nil {
		have = Ranges{}
	}
	return encode(map[string]any{"t": "resume", "have": have})
}
