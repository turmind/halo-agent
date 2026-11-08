// Package client: one WS to the hub, requests fanned out to
// the executor, idle watchdog, jittered reconnect, close classification, and
// the stop / fatal exit paths (drain in-flight calls first).
package client

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/protocol"
)

const (
	handshakeTimeout = 10 * time.Second
	lockedOutRetry   = 60 * time.Second
	exitDrain        = 2500 * time.Millisecond
	initialBackoff   = time.Second
	maxBackoff       = 30 * time.Second
	idleTimeout      = 60 * time.Second
	stopCloseGrace   = 2 * time.Second
)

// Executor answers one request (exec.Executor).
type Executor interface {
	Exec(ctx context.Context, op string, args map[string]any) (string, error)
}

// Options for Run.
type Options struct {
	Server  string // as given on the command line (logged verbatim)
	Token   string
	Headers http.Header
	Host    string   // `--header Host: …` (http.Header ignores Host)
	Proxy   *url.URL // `--proxy`: used alone; nil = HTTPS_PROXY / HTTP_PROXY / NO_PROXY
	Info    protocol.NodeInfo
	Exec    Executor
	Log     func(string)
}

// WSURL is nodeWsUrl. Stricter than new URL() for the special schemes: no
// host after `//` (`http:h`, `https:/h`) is Invalid URL here, a host in WHATWG (D4).
func WSURL(server string) (string, error) {
	u, err := url.Parse(server)
	special := u != nil && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "ws" || u.Scheme == "wss")
	if err != nil || u.Scheme == "" || special && (u.Opaque != "" || u.Host == "" || !validPort(u.Port())) {
		return "", errors.New("Invalid URL") // new URL() TypeError text
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("--server must be http(s):// or ws(s)://, got %s", server)
	}
	u.Path = strings.TrimRight(u.Path, "/") + protocol.WSPath
	u.RawPath = ""
	u.RawQuery, u.Fragment, u.ForceQuery = "", "", false
	return u.String(), nil
}

// validPort: url.Parse takes any digit run; WHATWG caps a port at 65535.
func validPort(p string) bool {
	if p == "" {
		return true
	}
	n, err := strconv.Atoi(p)
	return err == nil && n <= 65535
}

func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type node struct {
	o        Options
	url      string
	header   http.Header
	httpc    *http.Client
	mu       sync.Mutex
	backoff  time.Duration
	stopping bool
	running  map[string]*call
	inflight sync.WaitGroup
	conn     *websocket.Conn
	dialStop context.CancelFunc
	retry    *time.Timer
	done     chan int
	stopOnce sync.Once
	finished sync.Once
}

type call struct{ cancel context.CancelFunc }

// Run connects and serves until stopped (exit 0) or refused for good (exit 1).
// stop is closed by the caller on SIGINT / SIGTERM.
func Run(o Options, stop <-chan struct{}) (int, error) {
	u, err := WSURL(o.Server)
	if err != nil {
		return 1, err
	}
	proxy := http.ProxyFromEnvironment
	if o.Proxy != nil {
		proxy = http.ProxyURL(o.Proxy)
	}
	h := http.Header{}
	for k, vs := range o.Headers {
		for _, v := range vs {
			h.Set(k, v)
		}
	}
	h.Set("Authorization", "Bearer "+o.Token)
	h.Set(protocol.HeaderProtocol, fmt.Sprint(protocol.Version))
	h.Set(protocol.HeaderInstance, uuid4())
	h.Set(protocol.HeaderInfo, protocol.EncodeInfo(o.Info))
	n := &node{
		o: o, url: u, header: h, backoff: initialBackoff,
		running: map[string]*call{}, done: make(chan int, 1),
		// --proxy, else HTTPS_PROXY / HTTP_PROXY / NO_PROXY as Go reads them
		// (loopback hosts never proxied). A wss:// server goes through CONNECT,
		// so the token stays inside TLS; user:pass@ in the proxy URL becomes
		// Proxy-Authorization. No redirects: a 3xx is "server refused the
		// connection (HTTP 3xx)", and the token never goes to the Location.
		httpc: &http.Client{
			Transport:     &http.Transport{Proxy: proxy, TLSClientConfig: &tls.Config{}},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	go func() {
		<-stop
		n.stop()
	}()
	go n.connect()
	return <-n.done, nil
}

func (n *node) log(s string) { n.o.Log(s) }

func (n *node) finish(code int) { n.finished.Do(func() { n.done <- code }) }

func (n *node) abortAll() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := len(n.running)
	for _, r := range n.running {
		r.cancel()
	}
	n.running = map[string]*call{}
	return c
}

// drain waits for every in-flight exec, capped at exitDrain.
func (n *node) drain() {
	ch := make(chan struct{})
	go func() { n.inflight.Wait(); close(ch) }()
	select {
	case <-ch:
	case <-time.After(exitDrain):
	}
}

func (n *node) nextDelay(floor time.Duration) time.Duration {
	n.mu.Lock()
	defer n.mu.Unlock()
	ms := float64(n.backoff.Milliseconds()) * (0.8 + mrand.Float64()*0.4)
	d := time.Duration(roundHalfUp(ms)) * time.Millisecond
	if d < floor {
		d = floor
	}
	n.backoff = min(maxBackoff, n.backoff*2)
	return d
}

func roundHalfUp(x float64) int64 { return int64(x + 0.5) } // Math.round, x ≥ 0

func (n *node) scheduleRetry(why string, floor time.Duration) {
	d := n.nextDelay(floor)
	n.log(fmt.Sprintf("[Node] %s; reconnecting in %ss", why, jsv.ToFixed(float64(d.Milliseconds())/1000, 1)))
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopping {
		return
	}
	n.retry = time.AfterFunc(d, func() {
		n.mu.Lock()
		n.retry = nil
		n.mu.Unlock()
		n.connect()
	})
}

func (n *node) fatal(msg string) {
	n.log("[Node] " + msg)
	n.mu.Lock()
	n.stopping = true
	n.mu.Unlock()
	n.abortAll()
	go func() { n.drain(); n.finish(1) }()
}

func (n *node) isStopping() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.stopping
}

func (n *node) connect() {
	n.mu.Lock()
	if n.stopping {
		n.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	n.dialStop = cancel
	n.mu.Unlock()

	// Fed by open, every ping and every frame; fires → CloseNow (= terminate).
	var watchdog *time.Timer
	var connRef *websocket.Conn
	var wmu sync.Mutex
	feed := func() {
		wmu.Lock()
		defer wmu.Unlock()
		if watchdog != nil {
			watchdog.Reset(idleTimeout)
		}
	}
	c, resp, err := websocket.Dial(ctx, n.url, &websocket.DialOptions{
		HTTPClient:     n.httpc,
		HTTPHeader:     n.header,
		Host:           n.o.Host,
		OnPingReceived: func(context.Context, []byte) bool { feed(); return true },
	})
	cancel()
	if err != nil {
		status := 0
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			status = resp.StatusCode
		}
		n.closed(status, false, 1006, "", dialErrText(err))
		return
	}
	c.SetReadLimit(protocol.MaxFrameBytes)
	n.mu.Lock()
	n.conn = c
	stopping := n.stopping
	n.mu.Unlock()
	if stopping { // stop() raced the dial
		c.CloseNow()
		return
	}
	wmu.Lock()
	connRef = c
	watchdog = time.AfterFunc(idleTimeout, func() { connRef.CloseNow() })
	wmu.Unlock()

	welcomed := false
	// Background ctx: cancelling a Read ctx closes a coder conn (§4.3 #2).
	for {
		typ, data, err := c.Read(context.Background())
		if err != nil {
			// A failed control frame or an over-limit frame leaves the TCP
			// connection open; idempotent when the peer already closed it.
			c.CloseNow()
			wmu.Lock()
			watchdog.Stop()
			wmu.Unlock()
			n.mu.Lock()
			if n.conn == c {
				n.conn = nil
			}
			n.mu.Unlock()
			code := int(websocket.CloseStatus(err))
			reason := ""
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				reason = ce.Reason
			}
			if code == -1 {
				code = 1006
			}
			n.closed(0, welcomed, code, reason, "")
			return
		}
		feed()
		if typ != websocket.MessageText {
			continue
		}
		var f protocol.ServerFrame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		switch f.T {
		case "welcome":
			welcomed = true
			n.mu.Lock()
			n.backoff = initialBackoff
			n.mu.Unlock()
			n.log(fmt.Sprintf("[Node] connected as \"%s\" (workspace %s)", rawToString(f.Name), rawToString(f.Workspace)))
		case "req":
			var id string
			if json.Unmarshal(f.ID, &id) != nil || len(f.ID) == 0 || f.ID[0] != '"' {
				continue
			}
			n.handleRequest(c, id, f)
		case "cancel":
			var id string
			if json.Unmarshal(f.ID, &id) != nil {
				continue
			}
			n.mu.Lock()
			if r := n.running[id]; r != nil {
				delete(n.running, id)
				r.cancel()
			}
			n.mu.Unlock()
		}
	}
}

// `${x}` of a JSON field (template literal ToString).
func rawToString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "undefined"
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return "undefined"
	}
	return jsv.ToString(v)
}

func dialErrText(err error) string {
	s := err.Error()
	return strings.TrimPrefix(s, "failed to WebSocket dial: ")
}

func (n *node) closed(status int, welcomed bool, code int, reason, lastError string) {
	stopped := n.abortAll()
	if n.isStopping() { // stop() / fatal() own the exit
		return
	}
	switch {
	case status == 401:
		n.fatal("token rejected by the server (401) — check --token / HALO_NODE_TOKEN, or create a new one in Admin → Channels → Linked machines")
	case status == 404:
		n.fatal("the workspace this token is bound to no longer exists on the server (404)")
	case status == 426:
		n.fatal(fmt.Sprintf("protocol mismatch with the server (426, this node speaks v%d) — upgrade halo here or on the server", protocol.Version))
	case code == protocol.CloseRevoked:
		n.fatal("token revoked on the server — this machine is no longer linked")
	case status == 409 || (code == protocol.CloseReplaced && strings.Contains(reason, "another process")):
		n.scheduleRetry("this token is already connected from another process", 0)
	case status == 429:
		n.scheduleRetry("too many failed sign-ins from this address (429)", lockedOutRetry)
	case status != 0:
		n.scheduleRetry(fmt.Sprintf("server refused the connection (HTTP %d)", status), 0)
	case welcomed:
		r := ""
		if reason != "" {
			r = " " + reason
		}
		n.scheduleRetry(fmt.Sprintf("connection lost (%d%s) — stopped %d running call(s)", code, r, stopped), 0)
	default:
		w := ""
		if lastError != "" {
			w = " (" + lastError + ")"
		}
		n.scheduleRetry("could not connect"+w, 0)
	}
}

func (n *node) handleRequest(c *websocket.Conn, id string, f protocol.ServerFrame) {
	ctx, cancel := context.WithCancel(context.Background())
	me := &call{cancel}
	n.mu.Lock()
	if n.stopping {
		// stop / fatal is draining: an Add now could race inflight.Wait. No res
		// can go out after a stop on either side, so dropping is invisible.
		n.mu.Unlock()
		cancel()
		return
	}
	n.running[id] = me
	n.inflight.Add(1)
	n.mu.Unlock()
	reply := func(ok bool, body string) {
		n.mu.Lock()
		live := ctx.Err() == nil && n.running[id] == me
		if live {
			delete(n.running, id)
		}
		n.mu.Unlock()
		cancel()
		if !live {
			return
		}
		var sb strings.Builder
		sb.WriteString(`{"t":"res","id":`)
		jsv.WriteJSONString(&sb, id)
		if ok {
			sb.WriteString(`,"ok":true,"text":`)
		} else {
			sb.WriteString(`,"ok":false,"error":`)
		}
		jsv.WriteJSONString(&sb, body)
		sb.WriteByte('}')
		writeFragmented(c, sb.String())
	}
	var opV any
	_ = json.Unmarshal(f.Op, &opV)
	op, isStr := opV.(string)
	if !isStr || !protocol.Ops[op] {
		if len(f.Op) == 0 {
			opV = jsv.Undefined
		}
		reply(false, fmt.Sprintf("unknown op \"%s\"", jsv.ToString(opV)))
		n.inflight.Done()
		return
	}
	args := map[string]any{}
	if len(f.Args) > 0 {
		var a any
		if json.Unmarshal(f.Args, &a) == nil {
			if m, ok := a.(map[string]any); ok {
				args = m
			}
		}
	}
	go func() {
		defer n.inflight.Done()
		defer func() { // reply panicked: the call may be half on the wire, send nothing more
			if r := recover(); r != nil {
				n.log(crashLog(op, r))
			}
		}()
		text, err := n.exec(ctx, op, args)
		if err != nil {
			reply(false, err.Error())
		} else {
			reply(true, text)
		}
	}()
}

// exec is Exec with a panic (a bug in a port) turned into the call's error
// instead of killing the process; logged without args (they may hold file content).
func (n *node) exec(ctx context.Context, op string, args map[string]any) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			n.log(crashLog(op, r))
			text, err = "", fmt.Errorf("halo-node crashed running %s: %v", op, r)
		}
	}()
	return n.o.Exec.Exec(ctx, op, args)
}

func crashLog(op string, r any) string { return fmt.Sprintf("[Node] %s crashed: %v", op, r) }

// stop: abort calls, close(1000), exit 0 once closed and drained.
func (n *node) stop() {
	n.stopOnce.Do(func() {
		n.mu.Lock()
		if n.stopping { // a fatal is already exiting
			n.mu.Unlock()
			return
		}
		n.stopping = true
		if n.retry != nil {
			n.retry.Stop()
			n.retry = nil
		}
		c := n.conn
		dialStop := n.dialStop
		n.mu.Unlock()
		n.abortAll()
		drained := make(chan struct{})
		go func() { n.drain(); close(drained) }()
		if c == nil {
			if dialStop != nil {
				dialStop() // still CONNECTING: drop the dial
			}
			go func() { <-drained; n.finish(0) }()
			return
		}
		closed := make(chan struct{})
		go func() { _ = c.Close(websocket.StatusNormalClosure, "node stopped"); close(closed) }()
		go func() {
			select {
			case <-closed:
			case <-time.After(stopCloseGrace):
				// TS terminate(): give up on the handshake. Close() already holds
				// the closing flag, so CloseNow would only wait for it (coder's own
				// 5s); the exit that follows drops the socket.
			}
			<-drained
			n.finish(0)
		}()
	})
}

// fragment bounds one data frame of a reply: a pong (writeControl, 5s to get
// the frame lock) fits between fragments even on a slow uplink.
const fragment = 32 * 1024

// writeFragmented sends msg as one text message in fragment-sized frames
// (RFC 6455 §5.4; `ws` reassembles them).
func writeFragmented(c *websocket.Conn, msg string) {
	w, err := c.Writer(context.Background(), websocket.MessageText)
	if err != nil {
		return
	}
	defer w.Close() // releases the message lock on every path
	for len(msg) > 0 {
		k := min(fragment, len(msg))
		if _, err := io.WriteString(w, msg[:k]); err != nil {
			return
		}
		msg = msg[k:]
	}
}
