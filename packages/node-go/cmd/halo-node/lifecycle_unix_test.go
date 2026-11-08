//go:build !windows

package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// startRun starts a node with --allow-shell on a fresh root and returns it
// with the path its run call writes the shell's pid to.
func startRun(t *testing.T, server string) (*proc, string) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server, "--root", root, "--allow-shell"), filepath.Join(root, "run.pid")
}

const runReq = `{"t":"req","id":"r1","op":"run","args":{"command":"echo $$ > run.pid; sleep 30"}}`

// runPid waits for the run call's shell to write its pid.
func runPid(t *testing.T, pidFile string) int {
	t.Helper()
	var pid int
	until(t, 10*time.Second, "run started", func() bool {
		b, err := os.ReadFile(pidFile)
		pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && pid > 0
	})
	return pid
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	until(t, 5*time.Second, "the run's shell to exit", func() bool {
		return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
	})
}

// 4001 while a command runs: the command is killed, then exit 1.
func TestRevokedKillsRun(t *testing.T) {
	ready := make(chan *hubConn, 1)
	server, _ := fakeHub(t, func(_ int, w http.ResponseWriter, r *http.Request) {
		h := accept(t, w, r)
		h.send(t, welcome)
		h.send(t, runReq)
		ready <- h
		<-h.done
	})
	p, pidFile := startRun(t, server)
	h := <-ready
	pid := runPid(t, pidFile)
	_ = h.Close(4001, "token revoked")
	if code := p.wait(10 * time.Second); code != 1 {
		t.Fatalf("exit %d, output:\n%s", code, p.output())
	}
	waitGone(t, pid)
	p.waitOutput("[Node] token revoked on the server — this machine is no longer linked\n", time.Second)
	if strings.Contains(p.output(), "reconnecting") {
		t.Errorf("retried:\n%s", p.output())
	}
}

// TCP dropped while a command runs: 1006, the command stopped, reconnect.
func TestDroppedStopsRunAndReconnects(t *testing.T) {
	ready := make(chan *hubConn, 1)
	server, attempts := fakeHub(t, func(n int, w http.ResponseWriter, r *http.Request) {
		h := accept(t, w, r)
		h.send(t, welcome)
		if n == 1 {
			h.send(t, runReq)
			ready <- h
		}
		<-h.done
	})
	p, pidFile := startRun(t, server)
	h := <-ready
	pid := runPid(t, pidFile)
	h.CloseNow() // no close frame
	p.waitOutput("[Node] connection lost (1006) — stopped 1 running call(s); reconnecting in ", 10*time.Second)
	waitGone(t, pid)
	until(t, 10*time.Second, "reconnect", func() bool { return attempts() == 2 && strings.Count(p.output(), "[Node] connected as") == 2 })
	if got := h.received(); len(got) != 0 {
		t.Errorf("frames for the stopped call: %q", got)
	}
}

// A call answered over the wire; then SIGTERM stops the running command,
// closes 1000 "node stopped" and exits 0.
func TestSigterm(t *testing.T) {
	ready := make(chan *hubConn, 1)
	server, _ := fakeHub(t, func(_ int, w http.ResponseWriter, r *http.Request) {
		h := accept(t, w, r)
		h.send(t, welcome)
		h.send(t, `{"t":"req","id":"r0","op":"read","args":{"path":"hello.txt"}}`)
		h.send(t, runReq)
		ready <- h
		<-h.done
	})
	p, pidFile := startRun(t, server)
	h := <-ready
	pid := runPid(t, pidFile)
	until(t, 5*time.Second, "the read reply", func() bool { return len(h.received()) == 1 })
	if got, want := h.received()[0], `{"t":"res","id":"r0","ok":true,"text":"1\thello\n2\t"}`; got != want {
		t.Errorf("reply %s\nwant  %s", got, want)
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := p.wait(10 * time.Second); code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, p.output())
	}
	waitGone(t, pid)
	<-h.done
	if h.close != "1000 node stopped" || len(h.received()) != 1 {
		t.Errorf("close %q, frames %q", h.close, h.received())
	}
}

// SIGTERM while waiting out a retry: exit 0 without another attempt.
func TestSigtermWhileRetrying(t *testing.T) {
	server, attempts := fakeHub(t, func(_ int, w http.ResponseWriter, _ *http.Request) { w.WriteHeader(429) })
	p := startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server)
	p.waitOutput("reconnecting in 60.0s", 15*time.Second)
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := p.wait(10 * time.Second); code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, p.output())
	}
	if n := attempts(); n != 1 {
		t.Errorf("%d attempts", n)
	}
}
