package client

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type frame struct {
	op  byte
	fin bool
}

// slowPeer accepts one WebSocket client by hand on 16 KiB socket buffers,
// pings it once after `pingAfter`, and reads its frames at most 64 KiB per 50ms until the
// first data message's FIN — the uplink a big reply crawls through.
func slowPeer(t *testing.T, pingAfter time.Duration) (addr string, got chan []frame) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan []frame, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.(*net.TCPConn).SetReadBuffer(16 << 10)
		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		h := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+base64.StdEncoding.EncodeToString(h[:])+"\r\n\r\n")
		time.AfterFunc(pingAfter, func() { conn.Write([]byte{0x89, 0}) })
		slow := &throttled{r: br}
		var seq []frame
		for {
			var hd [2]byte
			if _, err := io.ReadFull(slow, hd[:]); err != nil {
				return
			}
			n := uint64(hd[1] & 0x7f)
			switch n {
			case 126:
				var b [2]byte
				io.ReadFull(slow, b[:])
				n = uint64(binary.BigEndian.Uint16(b[:]))
			case 127:
				var b [8]byte
				io.ReadFull(slow, b[:])
				n = binary.BigEndian.Uint64(b[:])
			}
			if _, err := io.CopyN(io.Discard, slow, int64(n)+4); err != nil { // + mask key
				return
			}
			f := frame{hd[0] & 0x0f, hd[0]&0x80 != 0}
			seq = append(seq, f)
			if f.fin && (f.op == 0 || f.op == 1) {
				got <- seq
				return
			}
		}
	}()
	return ln.Addr().String(), got
}

type throttled struct {
	r io.Reader
	n int
}

func (s *throttled) Read(p []byte) (int, error) {
	if s.n >= 64<<10 {
		time.Sleep(50 * time.Millisecond)
		s.n = 0
	}
	n, err := s.r.Read(p[:min(len(p), 64<<10-s.n)])
	s.n += n
	return n, err
}

func dialSmall(t *testing.T, addr string) *websocket.Conn {
	tr := &http.Transport{DialContext: func(ctx context.Context, network, a string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, a)
		if err == nil {
			c.(*net.TCPConn).SetWriteBuffer(16 << 10)
		}
		return c, err
	}}
	c, _, err := websocket.Dial(context.Background(), "ws://"+addr, &websocket.DialOptions{HTTPClient: &http.Client{Transport: tr}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	go func() { // reading is what answers the ping
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	return c
}

// pongBeforeFin: did the client's pong (opcode 10) get out before the reply's last frame?
func pongBeforeFin(seq []frame) bool {
	for _, f := range seq {
		if f.op == 10 {
			return true
		}
	}
	return false
}

// S4: a big reply on a slow uplink must not hold the frame lock end to end —
// a pong (writeControl gives up after 5s → the hub sees 1006) goes out between fragments.
func TestBigReplyLetsPongThrough(t *testing.T) {
	msg := `{"t":"res","id":"1","ok":true,"text":"` + strings.Repeat("a", 512<<10) + `"}`

	addr, got := slowPeer(t, 100*time.Millisecond)
	writeFragmented(dialSmall(t, addr), msg)
	var seq []frame
	select {
	case seq = <-got:
	case <-time.After(20 * time.Second):
		t.Fatal("peer never saw the reply's FIN")
	}
	if n := len(seq); n < 512<<10/fragment {
		t.Errorf("reply came in %d frames, want ≥ %d", n, 512<<10/fragment)
	}
	if !pongBeforeFin(seq) {
		t.Errorf("pong not interleaved: %v", seq)
	}

	// Contrast: one c.Write frame holds the lock until it is all on the wire.
	addr, got = slowPeer(t, 100*time.Millisecond)
	c := dialSmall(t, addr)
	_ = c.Write(context.Background(), websocket.MessageText, []byte(msg))
	select {
	case seq = <-got:
	case <-time.After(20 * time.Second):
		t.Fatal("single frame: peer never saw the FIN")
	}
	if len(seq) != 1 || pongBeforeFin(seq) {
		t.Errorf("single frame: %v — the test no longer discriminates", seq)
	}
}
