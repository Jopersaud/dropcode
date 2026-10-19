package proto

import (
	"strings"
	"testing"
)

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestParseMeta(t *testing.T) {
	m, err := Parse([]byte(`{"t":"meta","name":"../../etc/pass\u0000wd","size":10,"mime":"text/plain","sha256":"` + sha + `","chunkSize":65536}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Meta.Name != "passwd" || m.Meta.Size != 10 || m.Meta.Mime != "text/plain" {
		t.Fatalf("%+v", m.Meta)
	}
}

func TestParseRejects(t *testing.T) {
	for _, raw := range []string{
		`{`, `[]`, `{"t":"nope"}`, `{"t":"hello","v":1,"x":1}`, `{"t":"hello","v":1.5}`,
		`{"t":"meta","name":"a","size":-1,"mime":"x/y","sha256":"` + sha + `","chunkSize":65536}`,
		`{"t":"meta","name":"a","size":1.5,"mime":"x/y","sha256":"` + sha + `","chunkSize":65536}`,
		`{"t":"meta","name":"a","size":1,"mime":"x/y","sha256":"zz","chunkSize":65536}`,
		`{"t":"meta","name":"a","size":1,"mime":"x/y","sha256":"` + sha + `","chunkSize":1024}`,
		`{"t":"pake","msg":"not base64!"}`,
		`{"t":"resume","have":[[1]]}`,
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{"...": "download", `C:\Users\me\report.pdf`: "report.pdf", "a<b>.txt": "a_b_.txt"}
	for in, want := range cases {
		if got := SanitizeName(in); got != want {
			t.Errorf("SanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
	if n := len(SanitizeName(strings.Repeat("é", 300))); n > MaxNameBytes {
		t.Errorf("name too long: %d", n)
	}
}

func TestRanges(t *testing.T) {
	if got := Missing(Ranges{{0, 2}, {3, 4}}, 6); len(got) != 2 || got[0] != (Range{2, 3}) || got[1] != (Range{4, 6}) {
		t.Fatal(got)
	}
	has := map[int64]bool{0: true, 1: true, 2: true, 5: true, 7: true, 8: true}
	got := FromBitmap(func(i int64) bool { return has[i] }, 9)
	if len(got) != 3 || got[0] != (Range{0, 3}) || got[2] != (Range{7, 9}) {
		t.Fatal(got)
	}
	if CheckRanges(Ranges{{0, 11}}, 10) == nil || CheckRanges(Ranges{{5, 6}, {0, 2}}, 10) == nil || CheckRanges(Ranges{{0, 2}, {5, 6}}, 10) != nil {
		t.Fatal("CheckRanges")
	}
	if string(Resume(nil)) != `{"have":[],"t":"resume"}` {
		t.Fatal(string(Resume(nil)))
	}
}
