package client

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// HTTPS_PROXY routes the handshake: the proxy gets `CONNECT <host>:443`.
// http.ProxyFromEnvironment reads the env once per process, and other tests
// here dial through http.DefaultTransport first — so the check runs in a
// fresh child process (this same test, re-exec'd with the marker set).
func TestProxyFromEnvironment(t *testing.T) {
	if os.Getenv("HALO_NODE_PROXY_CHILD") == "" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestProxyFromEnvironment$", "-test.v")
		cmd.Env = append(os.Environ(), "HALO_NODE_PROXY_CHILD=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("child: %v\n%s", err, out)
		}
		return
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	lines := make(chan string, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadString('\n')
			lines <- strings.TrimSpace(line)
			_, _ = c.Write([]byte("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"))
			c.Close()
		}
	}()
	for _, k := range []string{"HTTP_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"} {
		os.Unsetenv(k)
	}
	os.Setenv("HTTPS_PROXY", "http://"+ln.Addr().String())

	stop := make(chan struct{})
	done := make(chan int, 1)
	go func() {
		code, _ := Run(Options{Server: "https://halo.invalid", Token: "t", Exec: okExec{}, Log: func(string) {}}, stop)
		done <- code
	}()
	select {
	case l := <-lines:
		if l != "CONNECT halo.invalid:443 HTTP/1.1" {
			t.Errorf("proxy got %q", l)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the proxy saw no request")
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}
