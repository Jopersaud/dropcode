// Package words generates and parses dropcode codes (nameplate-word-word),
// using the same BIP-39 English list as the web client.
package words

import (
	"crypto/rand"
	_ "embed"
	"encoding/binary"
	"fmt"
	"regexp"
	"strings"
)

//go:embed wordlist.txt
var wordlistText string

var (
	List        = strings.Fields(wordlistText)
	set         = map[string]bool{}
	nameplateRE = regexp.MustCompile(`^[1-9][0-9]{0,5}$`)
	splitRE     = regexp.MustCompile(`[\s-]+`)
)

func init() {
	if len(List) != 2048 {
		panic("wordlist must have 2048 entries")
	}
	for _, w := range List {
		set[w] = true
	}
}

// RandomWords returns two words chosen with crypto/rand (11 bits each).
func RandomWords() [2]string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return [2]string{List[binary.BigEndian.Uint16(b[0:2])&0x7ff], List[binary.BigEndian.Uint16(b[2:4])&0x7ff]}
}

type Code struct {
	Nameplate string
	Words     [2]string
}

// String is the canonical form, used verbatim as the SPAKE2 password.
func (c Code) String() string { return fmt.Sprintf("%s-%s-%s", c.Nameplate, c.Words[0], c.Words[1]) }

// Parse accepts "4-apple-river", " 4 Apple  River ", etc.
func Parse(input string) (Code, error) {
	parts := splitRE.Split(strings.ToLower(strings.TrimSpace(input)), -1)
	var p []string
	for _, s := range parts {
		if s != "" {
			p = append(p, s)
		}
	}
	if len(p) != 3 || !nameplateRE.MatchString(p[0]) || !set[p[1]] || !set[p[2]] {
		return Code{}, fmt.Errorf("%q is not a valid code (codes look like 4-apple-river)", input)
	}
	return Code{Nameplate: p[0], Words: [2]string{p[1], p[2]}}, nil
}
