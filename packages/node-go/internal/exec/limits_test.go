package exec

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsregex"
)

func newEx(t *testing.T) (*Executor, string, *[]string) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	var logs []string
	return New(Scope{Root: root, Base: root, Log: func(s string) { logs = append(logs, s) }}), root, &logs
}

func sparse(t *testing.T, p string, size int64) {
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func allocated(f func()) uint64 {
	var a, b runtime.MemStats
	runtime.ReadMemStats(&a)
	f()
	runtime.ReadMemStats(&b)
	return b.TotalAlloc - a.TotalAlloc
}

func run1(ex *Executor, op string, args map[string]any) string {
	text, err := ex.Exec(context.Background(), op, args)
	if err != nil {
		return "ERR " + err.Error()
	}
	return text
}

// fs.readFile(p, 'utf-8') limits, at Node 22's real values (sparse files: no disk, no read).
func TestReadFileSizeLimits(t *testing.T) {
	ex, root, _ := newEx(t)
	sparse(t, filepath.Join(root, "s600"), 600<<20)
	sparse(t, filepath.Join(root, "s3g"), 3<<30)
	for _, c := range []struct {
		op   string
		args map[string]any
		want string
	}{
		{"read", map[string]any{"path": "s600"}, toolWarn + "\nError: file too large to read in full (600.0 MB).\nPass `offset` and `limit` to read a specific range, or use `grep` to locate the section first."},
		{"read", map[string]any{"path": "s600", "offset": float64(1), "limit": float64(5)}, "ERR Invalid string length"},
		{"read", map[string]any{"path": "s3g", "offset": float64(1)}, "ERR File size (3221225472) is greater than 2 GiB"},
		{"edit", map[string]any{"path": "s600", "old_string": "a", "new_string": "b"}, "ERR Invalid string length"},
		{"edit", map[string]any{"path": "s3g", "old_string": "a", "new_string": "b"}, "ERR File size (3221225472) is greater than 2 GiB"},
		{"grep", map[string]any{"pattern": "x", "path": "s600"}, `No matches found for pattern "x"`},
	} {
		var got string
		if n := allocated(func() { got = run1(ex, c.op, c.args) }); n > 1<<20 {
			t.Errorf("%s %v: allocated %d bytes", c.op, c.args, n)
		}
		if got != c.want {
			t.Errorf("%s %v:\n got %q\nwant %q", c.op, c.args, got, c.want)
		}
	}
}

// Unsized input (a device) is read until the cap, never past it.
func TestReadFileStreamCap(t *testing.T) {
	old := v8StringMax
	v8StringMax = 1 << 20
	defer func() { v8StringMax = old }()
	ex, root, _ := newEx(t)
	_ = os.WriteFile(filepath.Join(root, "at"), []byte(strings.Repeat("a", 1<<20)), 0o644)
	_ = os.WriteFile(filepath.Join(root, "over"), []byte(strings.Repeat("a", 1<<20+1)), 0o644)
	_ = os.WriteFile(filepath.Join(root, "small.txt"), []byte("x1\n"), 0o644)
	whole := New(Scope{Base: root, Log: func(string) {}})
	var got string
	if n := allocated(func() { got = run1(whole, "read", map[string]any{"path": "/dev/zero", "offset": float64(1)}) }); n > 4<<20 {
		t.Errorf("/dev/zero: allocated %d bytes", n)
	}
	if got != "ERR Invalid string length" {
		t.Errorf("/dev/zero: %q", got)
	}
	if got := run1(ex, "read", map[string]any{"path": "at", "limit": float64(1)}); !strings.HasPrefix(got, "1\taaaa") {
		t.Errorf("at the cap: %.40q", got)
	}
	for _, op := range []string{"read", "edit"} {
		if got := run1(ex, op, map[string]any{"path": "over", "offset": float64(1), "old_string": "a", "new_string": "b"}); got != "ERR Invalid string length" {
			t.Errorf("%s over the cap: %.60q", op, got)
		}
	}
	// TS: sandboxReadFile throws → `continue` — the big file is skipped, the rest searched.
	if got := run1(ex, "grep", map[string]any{"pattern": "x"}); got != "small.txt:1:x1" {
		t.Errorf("grep dir: %.60q", got)
	}
}

func TestExecPanic(t *testing.T) {
	testPanic = func(op string) {
		if op == "read" {
			panic("boom")
		}
	}
	defer func() { testPanic = nil }()
	ex, root, logs := newEx(t)
	_ = os.WriteFile(filepath.Join(root, "a.txt"), []byte("a\n"), 0o644)
	if got := run1(ex, "read", map[string]any{"path": "a.txt", "content": "secret"}); got != "ERR halo-node crashed running read: boom" {
		t.Errorf("got %q", got)
	}
	if strings.Join(*logs, "\n") != "[Node] read crashed: boom" {
		t.Errorf("logs %q", *logs)
	}
	if got := run1(ex, "list", map[string]any{}); got != "📄 a.txt" {
		t.Errorf("after the panic: %q", got)
	}
}

// Each line takes ~0.5 s to fail: a cancel lands within one line, not after the file.
func TestGrepCancel(t *testing.T) {
	ex, root, _ := newEx(t)
	_ = os.WriteFile(filepath.Join(root, "bt.txt"), []byte(strings.Repeat(strings.Repeat("a", 22)+"!\n", 100)), 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	start := time.Now()
	_, _ = ex.Exec(ctx, "grep", map[string]any{"pattern": "^(a+)+$"})
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("grep took %v after cancel", d)
	}
}

// A test() past MatchTimeout aborts the whole call (V8 would still be backtracking).
func TestGrepMatchTimeout(t *testing.T) {
	old := jsregex.MatchTimeout
	jsregex.MatchTimeout = 200 * time.Millisecond
	defer func() { jsregex.MatchTimeout = old }()
	ex, root, _ := newEx(t)
	_ = os.WriteFile(filepath.Join(root, "bt.txt"), []byte("ok\n"+strings.Repeat(strings.Repeat("a", 40)+"!\n", 20)), 0o644)
	start := time.Now()
	_, err := ex.Exec(context.Background(), "grep", map[string]any{"pattern": "^(a+)+$|ok"})
	want := "regex match timed out after 200ms on bt.txt:2 — call aborted (catastrophic backtracking: simplify the pattern)"
	if err == nil || err.Error() != want {
		t.Errorf("got %v\nwant %s", err, want)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v: timed out per line instead of once", d)
	}
}
