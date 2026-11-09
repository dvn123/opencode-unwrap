package unwrap

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Row is one case of test/decisions.tsv.
type Row struct {
	Line                               int
	Group, Command, Decision, Fragment string
}

// readTable reads the decision table, with each command's escapes and
// placeholders filled in.
func readTable(t *testing.T, replacer *strings.Replacer) []Row {
	t.Helper()
	file, err := os.Open("../../test/decisions.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var rows []Row
	scanner := bufio.NewScanner(file)
	for line := 1; scanner.Scan(); line++ {
		text := scanner.Text()
		if text == "" || strings.HasPrefix(text, "#") || strings.HasPrefix(text, "group\t") {
			continue
		}
		fields := strings.Split(text, "\t")
		if len(fields) != 4 {
			t.Fatalf("decisions.tsv:%d has %d fields", line, len(fields))
		}
		rows = append(rows, Row{line, fields[0], replacer.Replace(fields[1]), fields[2], fields[3]})
	}
	return rows
}

// tableRules builds test/policy.json's rules for a session rooted at root.
func tableRules(t *testing.T, root string) Rules {
	t.Helper()
	data, err := os.ReadFile("../../test/policy.json")
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), "{extra}", filepath.Join(root, "extra")))
	var policy struct {
		Permissions Permissions `json:"permissions"`
		Reasons     Reasons     `json:"reasons"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	rules := BuildRules(policy.Permissions, policy.Reasons)
	rules.Root = root
	return rules
}

// TestDecisions judges every row of test/decisions.tsv in process; the
// Claude hook test runs the same table through the built binary.
func TestDecisions(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(root, "extra")
	if err := os.Mkdir(extra, 0o755); err != nil {
		t.Fatal(err)
	}
	// The symlinks the table's redirect rows write through.
	for link, target := range map[string]string{"escape": t.TempDir(), "inner": extra, "env-link": filepath.Join(root, ".env")} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	// Where `mktemp` with no template puts its file.
	t.Setenv("TMPDIR", extra)
	// Directories git would take for a bare repository: `bare`; `linked`,
	// whose commondir names bare; and `dotgit`, whose empty `.git` directory
	// git passes over. `bare/work` is a repository of its own.
	for _, dir := range []string{"bare/objects", "bare/refs", "linked", "dotgit/.git", "dotgit/objects", "dotgit/refs", "bare/work/.git/objects", "bare/work/.git/refs"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"bare/HEAD":           "ref: refs/heads/main\n",
		"linked/HEAD":         "ref: refs/heads/main\n",
		"linked/commondir":    "../bare\n",
		"dotgit/HEAD":         "ref: refs/heads/main\n",
		"bare/work/.git/HEAD": "ref: refs/heads/main\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rules := tableRules(t, root)
	replacer := strings.NewReplacer(`\n`, "\n", `\t`, "\t", "{extra}", filepath.Join(root, "extra"), "{root}", root)
	for _, row := range readTable(t, replacer) {
		decision, message := "abstain", rules.Why(row.Command, root)
		if d := rules.Decide(row.Command, root); d != nil {
			decision, message = d.Decision, d.Reason
		}
		if decision != row.Decision || !strings.Contains(message, row.Fragment) {
			t.Errorf("decisions.tsv:%d %s %q: got %s (%q), want %s containing %q",
				row.Line, row.Group, row.Command, decision, message, row.Decision, row.Fragment)
		}
	}
}
