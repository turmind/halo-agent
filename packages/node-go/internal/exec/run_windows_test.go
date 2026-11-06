//go:build windows

package exec

import (
	"bytes"
	"context"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsShell(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HALO_TEST_UNICODE", "中文")
	for _, c := range []struct{ command, out, stderr, msg string }{
		{"echo hello", "hello\r\n", "", ""},
		{"echo 中文", "中文\r\n", "", ""},
		{"echo %HALO_TEST_UNICODE%", "中文\r\n", "", ""},
		{"echo 100%", "100%\r\n", "", ""},
		{"echo a&echo b", "a\r\nb\r\n", "", ""},
		{"echo a^&b", "a&b\r\n", "", ""},
		{"echo hi|findstr hi", "hi\r\n", "", ""},
		{"echo err >&2", "", "err \r\n", ""},
		{"cd", root + "\r\n", "", ""},
		{"exit /b 3", "", "", "Command failed: exit /b 3"},
	} {
		out, stderr, msg, aborted := spawnGroup(context.Background(), c.command, root, 10000)
		if out != c.out || stderr != c.stderr || msg != c.msg || aborted {
			t.Errorf("%q: (%q,%q,%q,%v), want (%q,%q,%q,false)", c.command, out, stderr, msg, aborted, c.out, c.stderr, c.msg)
		}
	}
	// Quoted executable and argument paths containing spaces use cmd's quoting.
	script := filepath.Join(root, "with spaces.cmd")
	if err := os.WriteFile(script, []byte("@echo %~1\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, _, msg, _ := spawnGroup(context.Background(), `"`+script+`" "a b"`, root, 10000)
	if out != "a b\r\n" || msg != "" {
		t.Fatalf("quoted script: %q, %q", out, msg)
	}
	if err := checkCommand("not a POSIX command", root); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsOutput(t *testing.T) {
	for _, c := range []struct {
		b    []byte
		want string
	}{
		{[]byte("hello 中文\r\n"), "hello 中文\r\n"},
		{[]byte{0xd6, 0xd0, 0xce, 0xc4}, "中文"},
		{[]byte{0xef, 0xbb, 0xbf, 'x'}, "x"},
		{[]byte{0xff}, "\ufffd"},
	} {
		if got := decodeWinOutput(c.b); got != c.want {
			t.Errorf("decode %x = %q, want %q", c.b, got, c.want)
		}
		var b outBuf
		b.over = func() { t.Error("unexpected overflow") }
		var wg sync.WaitGroup
		wg.Add(1)
		b.pump(&byteReader{b: c.b}, &wg)
		wg.Wait()
		if got := b.String(); got != c.want {
			t.Errorf("split chunks = %q", got)
		}
	}
	var b outBuf
	over := false
	b.over = func() { over = true }
	var wg sync.WaitGroup
	wg.Add(1)
	b.pump(bytes.NewReader(bytes.Repeat([]byte("x"), maxBuffer+1)), &wg)
	wg.Wait()
	if !over || len(b.String()) != maxBuffer {
		t.Fatal("byte cap")
	}
}

type byteReader struct{ b []byte }

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, os.ErrClosed
	}
	p[0], r.b = r.b[0], r.b[1:]
	return 1, nil
}

// A real grandchild, not just cmd.exe, publishes its pid then holds the pipes.
// The test process acts as a helper so no PowerShell startup timing is involved.
func TestWindowsTreeHelper(t *testing.T) {
	mode := os.Getenv("HALO_TEST_TREE")
	if mode == "" {
		return
	}
	if mode == "parent" || mode == "background" {
		child := osexec.Command(os.Args[0], "-test.run=^TestWindowsTreeHelper$")
		child.Env = append(os.Environ(), "HALO_TEST_TREE=child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		if mode == "background" {
			// Let the test retain a handle to the live child before this process
			// and both shells exit. The child keeps both output pipes open.
			for {
				if _, err := os.Stat(os.Getenv("HALO_TEST_RELEASE")); err == nil {
					os.Exit(0)
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		_ = child.Wait()
		os.Exit(0)
	}
	_ = os.WriteFile(os.Getenv("HALO_TEST_PID"), []byte(strconv.Itoa(os.Getpid())), 0o600)
	fmt.Print("ready\r\n")
	time.Sleep(60 * time.Second)
	os.Exit(0)
}

func TestWindowsTreeStop(t *testing.T) {
	for _, cancelRun := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel=%v", cancelRun), func(t *testing.T) {
			root := t.TempDir()
			pidFile := filepath.Join(root, "child.pid")
			t.Setenv("HALO_TEST_TREE", "parent")
			t.Setenv("HALO_TEST_PID", pidFile)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			timeout := int64(3000)
			if cancelRun {
				timeout = 60000
			}
			type result struct {
				out, msg string
				aborted  bool
			}
			done := make(chan result, 1)
			go func() {
				out, _, msg, aborted := spawnGroup(ctx, `"`+os.Args[0]+`" -test.run=^TestWindowsTreeHelper$`, root, timeout)
				done <- result{out, msg, aborted}
			}()
			var pid int
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if b, err := os.ReadFile(pidFile); err == nil {
					pid, _ = strconv.Atoi(string(b))
					if pid != 0 {
						break
					}
				}
				time.Sleep(10 * time.Millisecond) // wait for the test helper's readiness file
			}
			if pid == 0 {
				t.Fatal("grandchild never started")
			}
			h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(h)
			defer windows.TerminateProcess(h, 1) // cleanup if the assertion fails
			if cancelRun {
				cancel()
			}
			select {
			case r := <-done:
				want := "Command timed out after 3000ms"
				if cancelRun {
					want = "The operation was aborted"
				}
				if r.msg != want || r.aborted != cancelRun || !strings.Contains(r.out, "ready") {
					t.Errorf("result: %+v", r)
				}
			case <-time.After(6 * time.Second):
				t.Fatal("tree stop did not settle")
			}
			if status, err := windows.WaitForSingleObject(h, 1000); err != nil || status != windows.WAIT_OBJECT_0 {
				t.Fatalf("grandchild still running: status=%d err=%v", status, err)
			}
		})
	}
}
