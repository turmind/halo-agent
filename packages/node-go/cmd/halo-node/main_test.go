package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMainHelper runs main() with the arguments after "--" (re-exec'd by runMain).
func TestMainHelper(t *testing.T) {
	if os.Getenv("HALO_TEST_MAIN") != "1" {
		return
	}
	i := slices.Index(os.Args, "--")
	if i < 0 {
		t.Fatal("missing CLI arguments")
	}
	os.Args = append(os.Args[:1], os.Args[i+1:]...)
	main()
}

// mainCmd is halo-node as a child process (TestMainHelper) with a clean proxy
// env plus env.
func mainCmd(ctx context.Context, env []string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestMainHelper$", "--"}, args...)...)
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.ToUpper(k) {
		case "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "REQUEST_METHOD":
		default:
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(append(cmd.Env, "HALO_TEST_MAIN=1"), env...)
	return cmd
}

// runMain runs halo-node (mainCmd) killed after `within`. Returns exit code
// (-1 = killed) and stdout + stderr.
func runMain(t *testing.T, within time.Duration, env []string, args ...string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	out, err := mainCmd(ctx, env, args...).CombinedOutput()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0, string(out)
	case ctx.Err() != nil:
		return -1, string(out)
	case errors.As(err, &exit):
		return exit.ExitCode(), string(out)
	}
	t.Fatalf("run: %v", err)
	return 0, ""
}

type seen struct{ line, auth string }

// fakeProxy records each request's first line and Proxy-Authorization, then
// answers 401 (a plain-http GET: the node takes it as a rejected token and
// exits 1) or 403 (a CONNECT: the node logs "could not connect" and retries).
func fakeProxy(t *testing.T) (addr string, got func() []seen) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var reqs []seen
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r, err := http.ReadRequest(bufio.NewReader(c))
				if err != nil {
					return
				}
				mu.Lock()
				reqs = append(reqs, seen{r.Method + " " + r.RequestURI, r.Header.Get("Proxy-Authorization")})
				mu.Unlock()
				status := "401 Unauthorized"
				if r.Method == http.MethodConnect {
					status = "403 Forbidden"
				}
				_, _ = c.Write([]byte("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
			}()
		}
	}()
	return ln.Addr().String(), func() []seen {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(reqs)
	}
}

const secret = "s3cret-pw"

func TestProxyFlag(t *testing.T) {
	const wantGet = "GET http://halo.invalid/api/nodes/connect"
	basic := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:"+secret))

	t.Run("--proxy wins over HTTP_PROXY; credentials become Proxy-Authorization, never output", func(t *testing.T) {
		flagProxy, flagGot := fakeProxy(t)
		envProxy, envGot := fakeProxy(t)
		code, out := runMain(t, 10*time.Second, []string{"HTTP_PROXY=http://" + envProxy, "HALO_NODE_TOKEN=t"},
			"--server", "http://halo.invalid", "--proxy", "http://alice:"+secret+"@"+flagProxy)
		if code != 1 || !strings.Contains(out, "token rejected by the server (401)") {
			t.Fatalf("exit %d, output:\n%s", code, out)
		}
		if g := flagGot(); len(g) != 1 || g[0].line != wantGet || g[0].auth != basic {
			t.Errorf("--proxy saw %+v", g)
		}
		if g := envGot(); len(g) != 0 {
			t.Errorf("HTTP_PROXY proxy saw %+v", g)
		}
		if !strings.Contains(out, "[Node] connecting through proxy http://alice:xxxxx@"+flagProxy+"\n") {
			t.Errorf("no redacted proxy line:\n%s", out)
		}
		if strings.Contains(out, secret) {
			t.Errorf("password in output:\n%s", out)
		}
	})

	t.Run("https server: CONNECT through --proxy; the could-not-connect retry line has no password", func(t *testing.T) {
		flagProxy, flagGot := fakeProxy(t)
		code, out := runMain(t, 2*time.Second, []string{"HALO_NODE_TOKEN=t"},
			"--server", "https://halo.invalid", "--proxy", "http://alice:"+secret+"@"+flagProxy)
		if code != -1 || !strings.Contains(out, "[Node] could not connect (") {
			t.Fatalf("exit %d, output:\n%s", code, out)
		}
		if g := flagGot(); len(g) == 0 || g[0].line != "CONNECT halo.invalid:443" || g[0].auth != basic {
			t.Errorf("--proxy saw %+v", g)
		}
		if strings.Contains(out, secret) {
			t.Errorf("password in output:\n%s", out)
		}
	})

	t.Run("no --proxy: HTTP_PROXY is used", func(t *testing.T) {
		envProxy, envGot := fakeProxy(t)
		code, out := runMain(t, 10*time.Second, []string{"HTTP_PROXY=http://" + envProxy, "HALO_NODE_TOKEN=t"},
			"--server", "http://halo.invalid")
		if code != 1 {
			t.Fatalf("exit %d, output:\n%s", code, out)
		}
		if g := envGot(); len(g) != 1 || g[0].line != wantGet || g[0].auth != "" {
			t.Errorf("HTTP_PROXY proxy saw %+v", g)
		}
		if strings.Contains(out, "connecting through proxy") {
			t.Errorf("proxy line without --proxy:\n%s", out)
		}
	})

	for _, bad := range []string{"socks5://alice:" + secret + "@127.0.0.1:1080", "ftp://127.0.0.1:21", "127.0.0.1:12334", "http://", "http:alice:" + secret, "://x", ""} {
		t.Run("refused: "+strings.ReplaceAll(bad, secret, "…"), func(t *testing.T) {
			code, out := runMain(t, 10*time.Second, []string{"HALO_NODE_TOKEN=t"}, "--server", "http://halo.invalid", "--proxy", bad)
			if code != 1 || !strings.HasPrefix(out, "halo-node: --proxy must be an http:// or https:// URL with a host, e.g. http://127.0.0.1:12334\n") {
				t.Fatalf("exit %d, output:\n%s", code, out)
			}
			if strings.Contains(out, secret) {
				t.Errorf("password in output:\n%s", out)
			}
		})
	}
}
