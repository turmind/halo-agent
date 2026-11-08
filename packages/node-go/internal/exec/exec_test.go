package exec

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Expected strings are the TS executor's output for the same tree (captured
// when the TS client still existed).
func TestOps(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "root")
	w := func(rel, data string) {
		p := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte(data), 0o644)
	}
	w("a.txt", "alpha\nbeta\ngamma\n")
	w("dup.txt", "x = 1\nx = 1\n")
	w("sub/b.ts", "export const b = 1\n")
	w("sub/c.tsx", "export const c = 2\nfoo\r\n")
	w("dist/z.ts", "skipped by walk\n")
	var logs []string
	ex := New(Scope{Root: root, Base: root, AllowShell: true, ShellTimeoutMs: 1500, Log: func(s string) { logs = append(logs, s) }})
	noShell := New(Scope{Root: root, Base: root, ShellTimeoutMs: 1500, Log: func(string) {}})
	type res struct{ text, err string }
	cases := []struct {
		name string
		ex   *Executor
		op   string
		args map[string]any
		want res
	}{
		{"read", ex, "read", map[string]any{"path": "a.txt"}, res{text: "1\talpha\n2\tbeta\n3\tgamma\n4\t"}},
		{"read range", ex, "read", map[string]any{"path": "a.txt", "offset": float64(2), "limit": float64(1)}, res{text: "2\tbeta\n... 2 more line(s) — use `offset=3` to continue."}},
		{"read past end", ex, "read", map[string]any{"path": "a.txt", "offset": float64(9)}, res{text: "(empty: file has 4 lines, offset=9 is past end)"}},
		{"read dir", ex, "read", map[string]any{"path": "sub"}, res{err: "EISDIR: illegal operation on a directory, read"}},
		{"read missing", ex, "read", map[string]any{"path": "nope.txt"}, res{err: "ENOENT: no such file or directory, stat '" + filepath.Join(root, "nope.txt") + "'"}},
		{"read no path", ex, "read", map[string]any{}, res{err: "`path` is required"}},
		{"read outside", ex, "read", map[string]any{"path": "../x"}, res{err: `"../x" is outside this machine's shared folder (` + root + `) — node tools can only reach paths inside it`}},
		{"write", ex, "write", map[string]any{"path": "new/deep/n.txt", "content": "hi"}, res{text: "File written: new/deep/n.txt"}},
		{"write number", ex, "write", map[string]any{"path": "n.txt", "content": float64(5)}, res{err: `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type number (5)`}},
		{"write parent file", ex, "write", map[string]any{"path": "a.txt/x.txt", "content": "x"}, res{err: "EEXIST: file already exists, mkdir '" + filepath.Join(root, "a.txt") + "'"}},
		{"edit multiple", ex, "edit", map[string]any{"path": "dup.txt", "old_string": "x = 1", "new_string": "y"}, res{text: "__TOOL_WARN__\nError: old_string appears more than once in dup.txt. Either expand it with surrounding context until it's unique, or pass replace_all: true."}},
		{"edit replace_all", ex, "edit", map[string]any{"path": "dup.txt", "old_string": "x = 1", "new_string": "y", "replace_all": true}, res{text: "File edited: dup.txt"}},
		{"edit identical", ex, "edit", map[string]any{"path": "nope", "old_string": "a", "new_string": "a"}, res{text: "__TOOL_WARN__\nError: old_string and new_string are identical — nothing to change."}},
		{"list", ex, "list", map[string]any{"path": "sub"}, res{text: "📄 b.ts\n📄 c.tsx"}},
		{"list recursive", ex, "list", map[string]any{"path": "new", "recursive": true}, res{text: "📁 deep/\n📄 deep/n.txt"}},
		{"list missing", ex, "list", map[string]any{"path": "nope"}, res{err: "ENOENT: no such file or directory, scandir '" + filepath.Join(root, "nope") + "'"}},
		{"grep", ex, "grep", map[string]any{"pattern": "export"}, res{text: "sub/b.ts:1:export const b = 1\nsub/c.tsx:1:export const c = 2"}},
		{"grep CR", ex, "grep", map[string]any{"pattern": "foo$", "path": "sub"}, res{text: `No matches found for pattern "foo$"`}},
		{"grep invalid", ex, "grep", map[string]any{"pattern": "("}, res{text: "__TOOL_WARN__\nError: Invalid regex pattern: Invalid regular expression: /(/: Unterminated group"}},
		{"grep include number", ex, "grep", map[string]any{"pattern": "a", "include": float64(5)}, res{err: "include is not iterable"}},
		{"glob", ex, "glob", map[string]any{"pattern": "**/*.ts"}, res{text: "sub/b.ts"}},
		{"glob hint", ex, "glob", map[string]any{"pattern": "nodir"}, res{text: "No files found matching pattern \"nodir\" (glob matches files, not directory names — if \"nodir\" is a directory, try \"nodir/**\" to list its files, or use the `file_list` tool)"}},
		{"glob no pattern", ex, "glob", map[string]any{}, res{err: "Cannot read properties of undefined (reading 'replace')"}},
		{"run", ex, "run", map[string]any{"command": "echo out; echo err >&2"}, res{text: "out\n\nSTDERR: err"}},
		{"run fail", ex, "run", map[string]any{"command": "echo o; exit 3"}, res{text: "__TOOL_ERROR__\nCommand failed: Command failed: echo o; exit 3\no\n\n"}},
		{"run cwd", ex, "run", map[string]any{"command": "pwd", "cwd": "sub"}, res{text: root + "/sub"}},
		{"run timeout", ex, "run", map[string]any{"command": "echo start; sleep 5"}, res{text: "__TOOL_ERROR__\nCommand failed: Command timed out after 1500ms\nstart\n\n"}},
		{"run empty", ex, "run", map[string]any{"command": "  "}, res{err: "`command` is required"}},
		{"run shell off", noShell, "run", map[string]any{"command": ""}, res{err: ShellDisabled}},
		{"unknown args type", ex, "list", map[string]any{"path": float64(1)}, res{text: strings.Join([]string{"📄 a.txt", "📁 dist", "📄 dup.txt", "📁 new", "📁 sub"}, "\n")}},
	}
	for _, c := range cases {
		// These commands and exact LF outputs are POSIX shell fixtures;
		// run_windows_test.go covers cmd.exe and its CRLF output natively.
		if runtime.GOOS == "windows" && (c.name == "run" || c.name == "run fail" || c.name == "run cwd" || c.name == "run timeout") {
			continue
		}
		if runtime.GOOS == "windows" && (c.name == "grep" || c.name == "glob") {
			c.want.text = strings.ReplaceAll(c.want.text, "/", `\`)
		}
		text, err := c.ex.Exec(context.Background(), c.op, c.args)
		got := res{text: text}
		if err != nil {
			got = res{err: err.Error()}
		}
		if got != c.want {
			t.Errorf("%s:\n got %+q\nwant %+q", c.name, got, c.want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "dup.txt")); string(b) != "y\ny\n" {
		t.Errorf("dup.txt = %q", b)
	}
	if !slicesContains(logs, "[Node] refused read ../x: outside root") {
		t.Errorf("refusal log missing: %q", logs)
	}
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
