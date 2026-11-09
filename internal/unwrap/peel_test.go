package unwrap

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

func golden[T any](t *testing.T, name string) map[string]T {
	t.Helper()
	data, err := os.ReadFile("../../test/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var table map[string]T
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

// Exact lists: a missing spelling lets a denied command through, and an extra
// one can deny a command that never runs the denied program.
func TestSpellings(t *testing.T) {
	for command, expected := range golden[[]string](t, "spellings.json") {
		if got := append([]string{}, Peeled(command)...); !slices.Equal(got, expected) {
			t.Errorf("Peeled(%q) = %q, want %q", command, got, expected)
		}
	}
}

// The one layer an allow is carried through under test/policy.json's
// policy, or null.
func TestTransparent(t *testing.T) {
	var file struct {
		Policy Policy `json:"policy"`
	}
	data, err := os.ReadFile("../../test/policy.json")
	if err != nil || json.Unmarshal(data, &file) != nil {
		t.Fatal("cannot read test/policy.json")
	}
	for command, expected := range golden[*string](t, "transparent.json") {
		inner, ok := file.Policy.Peel(TextWords(command))
		got := strings.Join(inner, " ")
		switch {
		case expected == nil && ok:
			t.Errorf("Peel(%q) = %q, want none", command, got)
		case expected != nil && (!ok || got != *expected):
			t.Errorf("Peel(%q) = %q, %v, want %q", command, got, ok, *expected)
		}
	}
}

// OpenCode's `Wildcard.match`, ported.
func TestMatch(t *testing.T) {
	for _, c := range []struct {
		pattern, input string
		want           bool
	}{
		{"rm *", "rm", true},
		{"rm *", "rm -rf x", true},
		{"rm *", "rmdir x", false},
		{"git * push *", "git -C repo push origin", true},
		{"a?c", "abc", true},
		{"*.env", `dir\.env`, true},
	} {
		if got := Match(c.input, c.pattern); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.input, c.pattern, got, c.want)
		}
	}
}

// A rule may match a template when some value of its Wilds makes it match,
// and must match it when every value does.
func TestTemplates(t *testing.T) {
	for _, c := range []struct {
		rule, template string
		may, must      bool
	}{
		{"git push * --force *", "git push " + Wild + " origin", true, false},
		{"git push --force *", "git push origin", false, false},
		{"git *", "git status " + Wild, true, true},
		{"git status *", "git status", true, true},
		{"git status *", "git status " + Wild, true, true},
		{"git status", "git status " + Wild, false, false},
		{"*TOKEN*", "echo " + Wild, true, false},
		{"rm *", "rmdir " + Wild, false, false},
		{"python 'scripts/x.py' *", "python scripts/x.py " + Wild, true, true},
	} {
		if got := MayMatch(c.rule, c.template); got != c.may {
			t.Errorf("MayMatch(%q, %q) = %v, want %v", c.rule, c.template, got, c.may)
		}
		if got := MustMatch(c.rule, c.template); got != c.must {
			t.Errorf("MustMatch(%q, %q) = %v, want %v", c.rule, c.template, got, c.must)
		}
	}
}
