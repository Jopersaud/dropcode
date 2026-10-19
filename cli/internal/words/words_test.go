package words

import (
	"os"
	"testing"
)

func TestParse(t *testing.T) {
	c, err := Parse("  4 Apple  river ")
	if err != nil || c.String() != "4-apple-river" {
		t.Fatal(c, err)
	}
	for _, bad := range []string{"4-apple", "04-apple-river", "4-apple-xyzzy", "1234567-apple-river", ""} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	w := RandomWords()
	if _, err := Parse("7-" + w[0] + "-" + w[1]); err != nil {
		t.Fatal(err)
	}
}

func TestWordlistMatchesShared(t *testing.T) {
	shared, err := os.ReadFile("../../../shared/wordlist.txt")
	if err != nil {
		t.Skip(err)
	}
	if string(shared) != wordlistText {
		t.Fatal("cli/internal/words/wordlist.txt differs from shared/wordlist.txt")
	}
}
