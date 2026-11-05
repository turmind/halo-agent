package client

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/turmind/halo-agent/packages/node-go/internal/protocol"
)

func TestWSURL(t *testing.T) {
	for _, c := range []struct{ in, want, err string }{
		{"http://h:9527", "ws://h:9527/api/nodes/connect", ""},
		{"https://h/x/", "wss://h/x/api/nodes/connect", ""},
		{"https://h/x///?q=1#f", "wss://h/x/api/nodes/connect", ""},
		{"ws://h", "ws://h/api/nodes/connect", ""},
		{"wss://h:1/p", "wss://h:1/p/api/nodes/connect", ""},
		{"ftp://x", "", "--server must be http(s):// or ws(s)://, got ftp://x"},
		{"localhost:9527", "", "--server must be http(s):// or ws(s)://, got localhost:9527"},
		{"http//x", "", "Invalid URL"},
		{"http:h", "", "Invalid URL"}, // WHATWG: host h; Go: opaque — refused (D4)
		{"https:/h", "", "Invalid URL"},
		{"http://h:65536", "", "Invalid URL"},
		{"http://h:99999999999999999999", "", "Invalid URL"},
		{"http://h:65535", "ws://h:65535/api/nodes/connect", ""},
		{"mailto:x", "", "--server must be http(s):// or ws(s)://, got mailto:x"},
	} {
		got, err := WSURL(c.in)
		if c.err != "" {
			if err == nil || err.Error() != c.err {
				t.Errorf("%q: err %v, want %q", c.in, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	if u := uuid4(); len(u) != 36 || u[14] != '4' {
		t.Errorf("uuid4 %q", u)
	}
}

type blockExec struct{ release chan struct{} }

func (b blockExec) Exec(ctx context.Context, op string, args map[string]any) (string, error) {
	select {
	case <-ctx.Done():
	case <-b.release:
	}
	return "", nil
}

// S1: a req that lands while stop / fatal drains is dropped — never an
// inflight.Add racing inflight.Wait (WaitGroup misuse → panic, exit 2).
func TestRequestWhileStopping(t *testing.T) {
	for i := 0; i < 200; i++ {
		n := &node{o: Options{Exec: blockExec{make(chan struct{})}, Log: func(string) {}}, running: map[string]*call{}, done: make(chan int, 1)}
		n.handleRequest(nil, "a", protocol.ServerFrame{Op: json.RawMessage(`"read"`)})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); n.fatal("x") }()
		go func() {
			defer wg.Done()
			n.handleRequest(nil, "b", protocol.ServerFrame{Op: json.RawMessage(`"read"`)})
		}()
		wg.Wait()
		select {
		case code := <-n.done:
			if code != 1 {
				t.Fatalf("exit %d", code)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("never drained")
		}
		n.mu.Lock()
		left := len(n.running)
		n.mu.Unlock()
		if left != 0 { // b either beat fatal (then abortAll cleared it) or was dropped
			t.Fatalf("%d call(s) registered after stop", left)
		}
	}
}
