package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The connection lifecycle of the process against a fake hub: which refusals
// exit 1 and which retry, close codes after the upgrade, and the reconnect
// backoff. Expected lines are client.go closed()'s own wording.

const welcome = `{"t":"welcome","name":"m","workspace":"/ws"}`

// fakeHub answers every connection attempt with handle (attempt counts from 1).
func fakeHub(t *testing.T, handle func(attempt int, w http.ResponseWriter, r *http.Request)) (server string, attempts func() int) {
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		k := n
		mu.Unlock()
		handle(k, w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() int { mu.Lock(); defer mu.Unlock(); return n }
}

// hubConn is the hub's end of one accepted connection; it reads every node
// frame in the background and records how the node closed it.
type hubConn struct {
	*websocket.Conn
	mu     sync.Mutex
	frames []string
	close  string // "<code> <reason>" of the node's close frame
	done   chan struct{}
}

func accept(t *testing.T, w http.ResponseWriter, r *http.Request) *hubConn {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		t.Error(err)
		return nil
	}
	h := &hubConn{Conn: c, done: make(chan struct{})}
	go func() {
		defer close(h.done)
		for {
			_, b, err := c.Read(context.Background())
			h.mu.Lock()
			if err != nil {
				var ce websocket.CloseError
				if errors.As(err, &ce) {
					h.close = fmt.Sprintf("%d %s", ce.Code, ce.Reason)
				}
				h.mu.Unlock()
				return
			}
			h.frames = append(h.frames, string(b))
			h.mu.Unlock()
		}
	}()
	return h
}

func (h *hubConn) send(t *testing.T, frame string) {
	if err := h.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
		t.Error(err)
	}
}

func (h *hubConn) received() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.frames...)
}

// proc is a running halo-node (mainCmd) with its stdout + stderr collected.
type proc struct {
	t    *testing.T
	mu   sync.Mutex
	buf  []byte
	done chan struct{}
	code int
	cmd  *exec.Cmd
}

func (p *proc) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf = append(p.buf, b...)
	return len(b), nil
}

func (p *proc) output() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return string(p.buf)
}

func startMain(t *testing.T, env []string, args ...string) *proc {
	t.Helper()
	cmd := mainCmd(context.Background(), env, args...)
	p := &proc{t: t, done: make(chan struct{}), cmd: cmd}
	cmd.Stdout, cmd.Stderr = p, p
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = cmd.Wait()
		p.code = cmd.ProcessState.ExitCode()
		close(p.done)
	}()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-p.done })
	return p
}

// wait returns the exit code; fails the test if the process is still running after within.
func (p *proc) wait(within time.Duration) int {
	p.t.Helper()
	select {
	case <-p.done:
		return p.code
	case <-time.After(within):
		p.t.Fatalf("still running after %v, output:\n%s", within, p.output())
		return 0
	}
}

func (p *proc) waitOutput(s string, within time.Duration) {
	p.t.Helper()
	until(p.t, within, func() string { return fmt.Sprintf("output %q, got:\n%s", s, p.output()) }, func() bool { return strings.Contains(p.output(), s) })
}

func until(t *testing.T, within time.Duration, what any, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			if f, ok := what.(func() string); ok {
				what = f()
			}
			t.Fatalf("timed out waiting for %v", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Refused for good: one attempt, the reason, exit 1.
func TestFatalRefusal(t *testing.T) {
	for _, c := range []struct {
		status int
		want   string
	}{
		{401, "[Node] token rejected by the server (401) — check --token / HALO_NODE_TOKEN, or create a new one in Admin → Channels → Linked machines\n"},
		{404, "[Node] the workspace this token is bound to no longer exists on the server (404)\n"},
		{426, "[Node] protocol mismatch with the server (426, this node speaks v1) — upgrade halo-node here or halo on the server, whichever is older\n"},
	} {
		t.Run(strconv.Itoa(c.status), func(t *testing.T) {
			var mu sync.Mutex
			var hdr http.Header
			var host string
			server, attempts := fakeHub(t, func(_ int, w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				hdr, host = r.Header.Clone(), r.Host
				mu.Unlock()
				w.WriteHeader(c.status)
			})
			code, out := runMain(t, 15*time.Second, []string{"HALO_NODE_TOKEN=tok"},
				"--server", server, "--header", "Host: example.test:1234", "--header", "X-Probe: a:b:c")
			if code != 1 || !strings.Contains(out, c.want) || strings.Contains(out, "reconnecting") {
				t.Fatalf("exit %d, output:\n%s", code, out)
			}
			if n := attempts(); n != 1 {
				t.Errorf("%d attempts", n)
			}
			mu.Lock()
			defer mu.Unlock()
			if host != "example.test:1234" || hdr.Get("Authorization") != "Bearer tok" || hdr.Get("X-Probe") != "a:b:c" ||
				hdr.Get("X-Halo-Node-Protocol") != "1" || len(hdr.Get("X-Halo-Node-Instance")) != 36 || hdr.Get("X-Halo-Node-Info") == "" {
				t.Errorf("handshake host %q, headers %v", host, hdr)
			}
		})
	}
}

// Refused for now: the reason and a retry; a redirect is never followed.
func TestRetryRefusal(t *testing.T) {
	for _, c := range []struct {
		status int
		want   string
	}{
		{409, "[Node] this token is already connected from another process; reconnecting in "},
		{503, "[Node] server refused the connection (HTTP 503); reconnecting in "},
		{301, "[Node] server refused the connection (HTTP 301); reconnecting in "},
	} {
		t.Run(strconv.Itoa(c.status), func(t *testing.T) {
			var mu sync.Mutex
			var paths []string
			server, attempts := fakeHub(t, func(_ int, w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				paths = append(paths, r.URL.Path)
				mu.Unlock()
				w.Header().Set("Location", "/moved")
				w.WriteHeader(c.status)
			})
			p := startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server)
			until(t, 15*time.Second, "a second attempt", func() bool { return attempts() >= 2 })
			p.waitOutput(c.want, 5*time.Second)
			mu.Lock()
			defer mu.Unlock()
			for _, u := range paths {
				if u != "/api/nodes/connect" {
					t.Errorf("request to %s", u)
				}
			}
		})
	}

	t.Run("429 waits 60s", func(t *testing.T) {
		server, attempts := fakeHub(t, func(_ int, w http.ResponseWriter, _ *http.Request) { w.WriteHeader(429) })
		p := startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server)
		p.waitOutput("[Node] too many failed sign-ins from this address (429); reconnecting in 60.0s\n", 15*time.Second)
		time.Sleep(1500 * time.Millisecond) // past the ≤1.2s first backoff
		if n := attempts(); n != 1 {
			t.Errorf("%d attempts", n)
		}
	})
}

// Closed by the hub after the upgrade.
func TestCloseAfterOpen(t *testing.T) {
	for _, c := range []struct {
		name    string
		welcome bool
		code    websocket.StatusCode
		reason  string
		fatal   bool
		want    string
	}{
		{"4001 revoked", true, 4001, "token revoked", true, "[Node] token revoked on the server — this machine is no longer linked\n"},
		{"4009 held by another process", false, 4009, "already connected from another process", false, "[Node] this token is already connected from another process; reconnecting in "},
		{"1001 server shutting down", true, 1001, "server shutting down", false, "[Node] connection lost (1001 server shutting down) — stopped 0 running call(s); reconnecting in "},
	} {
		t.Run(c.name, func(t *testing.T) {
			server, attempts := fakeHub(t, func(_ int, w http.ResponseWriter, r *http.Request) {
				h := accept(t, w, r)
				if c.welcome {
					h.send(t, welcome)
				}
				_ = h.Close(c.code, c.reason)
			})
			p := startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server)
			if c.fatal {
				if code := p.wait(15 * time.Second); code != 1 {
					t.Fatalf("exit %d, output:\n%s", code, p.output())
				}
				if n := attempts(); n != 1 {
					t.Errorf("%d attempts", n)
				}
			} else {
				until(t, 15*time.Second, "a second attempt", func() bool { return attempts() >= 2 })
			}
			p.waitOutput(c.want, 5*time.Second)
		})
	}
}

var reconnectIn = regexp.MustCompile(`reconnecting in (\d+\.\d)s`)

// Backoff doubles from 1s (±20%) on each failure and drops back to 1s once a
// connection got its welcome.
func TestReconnectBackoff(t *testing.T) {
	server, _ := fakeHub(t, func(n int, w http.ResponseWriter, r *http.Request) {
		switch n {
		case 1, 2:
			w.WriteHeader(503)
		case 3:
			h := accept(t, w, r)
			h.send(t, welcome)
			_ = h.Close(1001, "server shutting down")
		default:
			accept(t, w, r).send(t, welcome)
		}
	})
	p := startMain(t, []string{"HALO_NODE_TOKEN=t"}, "--server", server)
	until(t, 20*time.Second, "the second welcome", func() bool { return strings.Count(p.output(), "[Node] connected as \"m\" (workspace /ws)\n") == 2 })
	var got []float64
	for _, m := range reconnectIn.FindAllStringSubmatch(p.output(), -1) {
		f, _ := strconv.ParseFloat(m[1], 64)
		got = append(got, f)
	}
	want := []float64{1, 2, 1}
	if len(got) != len(want) {
		t.Fatalf("delays %v, output:\n%s", got, p.output())
	}
	for i, base := range want {
		if got[i] < base*0.8 || got[i] > base*1.2 {
			t.Errorf("delay %d = %vs, want %vs ±20%%", i+1, got[i], base)
		}
	}
}
