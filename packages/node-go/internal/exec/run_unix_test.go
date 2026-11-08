//go:build !windows

package exec

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// node_run on the POSIX shell, beyond TestOps: the child env, placeholders,
// the rm guard, undecodable output and a background child holding the pipe.
func TestRunShell(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	keep := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(keep, []byte("k"), 0o644); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{"HALO_NODE_TOKEN": "n", "HALO_PASSWORD": "p", "HALO_JWT_SECRET": "j", "KEEP_ME": "k"} {
		t.Setenv(k, v)
	}
	var logs []string
	ex := New(Scope{Root: root, Base: root, AllowShell: true, ShellTimeoutMs: 5000, Log: func(s string) { logs = append(logs, s) }})
	run := func(command string) string {
		t.Helper()
		text, err := ex.Exec(context.Background(), "run", map[string]any{"command": command})
		if err != nil {
			t.Fatalf("%s: %v", command, err)
		}
		return text
	}

	if got := run(`echo "[${HALO_NODE_TOKEN-unset}][${HALO_PASSWORD-unset}][${HALO_JWT_SECRET-unset}][${KEEP_ME-unset}]"`); got != "[unset][unset][unset][k]" {
		t.Errorf("env: %q", got)
	}

	logs = nil
	if got := run(`echo "{{foo.params.bar}}"`); got != "{{foo.params.bar}}" {
		t.Errorf("placeholder: %q", got)
	}
	if !slicesContains(logs, "[WorkspaceTools] {{foo.params.bar}} rejected — namespace not in allowed list") {
		t.Errorf("placeholder log: %q", logs)
	}

	// cwd is the scratch root: were the guard to let it through, only the temp dir would go.
	want := "__TOOL_ERROR__\nCommand failed: [Sandbox] rm blocked: \".\" resolves to " + root + ", which is the workspace root or a parent of it. Name the specific files or subdirectories to delete instead.\n\n"
	if got := run("rm -rf ."); got != want {
		t.Errorf("rm guard:\n got %q\nwant %q", got, want)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("rm ran: %v", err)
	}

	if got := run(`printf 'caf\303\251 \377 done'`); got != "café \uFFFD done" {
		t.Errorf("invalid UTF-8: %q", got)
	}

	// Like Node's 'close': the call settles once the shell exited AND every
	// holder of its stdout let go — here the backgrounded sleep.
	t0 := time.Now()
	if got := run("sleep 1 & echo bg"); got != "bg" {
		t.Errorf("background: %q", got)
	}
	if d := time.Since(t0); d < 900*time.Millisecond {
		t.Errorf("background: settled after %v, before the sleep let go of the pipe", d)
	}
}
