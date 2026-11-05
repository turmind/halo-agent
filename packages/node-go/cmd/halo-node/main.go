// halo-node: the standalone `halo node` client (same flags, same wire v1, same
// tool output as the TS one). Design and accepted differences from the TS client:
// .halo/docs/design/node.md ("Go client: known differences from the TS client").
package main

import (
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	_ "golang.org/x/crypto/x509roots/fallback" // only used when the system pool is missing

	"github.com/turmind/halo-agent/packages/node-go/internal/client"
	"github.com/turmind/halo-agent/packages/node-go/internal/exec"
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/protocol"
)

var version = "dev"

const help = `Usage: halo-node --server <url> [--root <dir>] [--token <t>] [--allow-shell] [--header "Name: value"]

Link this machine to a workspace on a halo server, so that workspace's
full-access agents can read, write and search files here (node_* tools) and,
with --allow-shell, run commands. Runs in the foreground; Ctrl-C to stop.
Needs no ` + "`halo setup`" + ` and no model keys on this machine.

Flags:
  --server <url>     http(s)://host:port of the server (ws(s):// also accepted)
  --root <dir>       folder to share — every path the agent uses must stay
                     inside it. Omit it for whole-machine mode: any path this
                     user can reach, relative paths from the current dir.
  --token <t>        pairing token (Admin → Channels → Linked machines). Prefer
                     the HALO_NODE_TOKEN env var: a flag shows up in ps and
                     shell history.
  --allow-shell      let the agent run commands (node_run), as this user and
                     not sandboxed; their cwd stays inside --root. Off by default.
  --header "N: v"    optional, repeatable. Extra header on the connection, for
                     an auth proxy in front of the server (cookie, CF-Access-*).
`

type headerList []string

func (h *headerList) String() string     { return strings.Join(*h, ", ") }
func (h *headerList) Set(v string) error { *h = append(*h, v); return nil }

// httpToken is Node's checkIsHttpToken (RFC 7230 tchar+).
func httpToken(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0) {
			return false
		}
	}
	return true
}

// headerValue is Node's checkInvalidHeaderChar inverted: HTAB, 0x20-0x7E and
// 0x80-0xFF per UTF-16 unit (a code point above U+00FF is invalid too).
func headerValue(s string) bool {
	for _, r := range s {
		if r != '\t' && (r < 0x20 || r == 0x7f || r > 0xff) {
			return false
		}
	}
	return true
}

func fail(msg string) {
	fmt.Fprintf(os.Stderr, "halo-node: %s\n\n%s", msg, help)
	os.Exit(1)
}

// shellTimeoutMs is config.timeout.shellExec: HALO_SHELL_TIMEOUT via parseInt,
// default 120000 (settings yaml not read — D8).
func shellTimeoutMs() int64 {
	if v, ok := os.LookupEnv("HALO_SHELL_TIMEOUT"); ok {
		if n, ok := jsv.ParseInt(v); ok {
			return n
		}
	}
	return 120000
}

func main() {
	fs := flag.NewFlagSet("halo-node", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "", "")
	root := fs.String("root", "", "")
	token := fs.String("token", "", "")
	allowShell := fs.Bool("allow-shell", false, "")
	showVersion := fs.Bool("version", false, "")
	var headers headerList
	fs.Var(&headers, "header", "")
	if err := fs.Parse(os.Args[1:]); err != nil {
		if err == flag.ErrHelp {
			fmt.Fprint(os.Stderr, help)
			return
		}
		fail(err.Error())
	}
	if *showVersion {
		fmt.Println("halo-node " + version)
		return
	}
	if fs.NArg() > 0 {
		fail(fmt.Sprintf("unexpected argument '%s'", fs.Arg(0)))
	}
	rootSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "root" {
			rootSet = true
		}
	})
	tok := *token
	tokenSet := false
	fs.Visit(func(f *flag.Flag) { tokenSet = tokenSet || f.Name == "token" })
	if !tokenSet { // TS `values.token ?? env`: an explicit --token "" stays ""
		tok = os.Getenv("HALO_NODE_TOKEN")
	}
	_ = os.Unsetenv("HALO_NODE_TOKEN")
	if *server == "" {
		fail("--server is required")
	}
	if tok == "" {
		fail("--token (or HALO_NODE_TOKEN) is required")
	}
	hdr := http.Header{}
	host := ""
	// TS's `headers[name] = value` object: first-seen order, last value wins.
	var hdrNames []string
	hdrVals := map[string]string{}
	for _, h := range headers {
		i := strings.Index(h, ":")
		if i <= 0 {
			fail(fmt.Sprintf("invalid --header (expected \"Name: value\"): %s", h))
		}
		name, val := strings.TrimSpace(h[:i]), strings.TrimSpace(h[i+1:])
		if _, seen := hdrVals[name]; !seen {
			hdrNames = append(hdrNames, name)
		}
		hdrVals[name] = val
		if strings.EqualFold(name, "host") {
			host = val
			continue
		}
		hdr.Set(name, val)
	}
	if _, err := client.WSURL(*server); err != nil {
		fail(err.Error())
	}

	logf := func(s string) { os.Stdout.WriteString(s + "\n") }
	whole := !rootSet || *root == "/"
	var rootPath *string
	base := ""
	if !whole {
		abs, _ := filepath.Abs(*root)
		real, err := filepath.EvalSymlinks(abs)
		if err != nil {
			fail(fmt.Sprintf("--root %s: no such directory", *root))
		}
		if st, err := os.Stat(real); err != nil || !st.IsDir() {
			fail(fmt.Sprintf("--root %s: not a directory", *root))
		}
		rootPath, base = &real, real
	} else {
		wd, _ := os.Getwd()
		base, _ = filepath.EvalSymlinks(wd)
	}
	timeout := shellTimeoutMs()
	hostname, _ := os.Hostname()
	info := protocol.NodeInfo{
		Root: rootPath, Base: base, Shell: *allowShell, ShellTimeoutMs: timeout,
		OS: runtime.GOOS, Hostname: hostname, Version: version,
	}
	if whole {
		if !rootSet {
			logf("[Node] whole-machine mode: no --root given, paths are not limited to a folder — pass --root <folder> to limit them")
		} else {
			logf("[Node] whole-machine mode (--root /): paths are not limited to a folder")
		}
		logf(fmt.Sprintf("[Node] sharing this machine (relative paths from %s) → %s", base, *server))
	} else {
		logf(fmt.Sprintf("[Node] sharing %s → %s", base, *server))
	}
	if *allowShell {
		name := os.Getenv("USER")
		if u, err := user.Current(); err == nil {
			name = u.Username
		}
		inRoot := ""
		if !whole {
			inRoot = "cwd stays inside root, "
		}
		logf(fmt.Sprintf("[Node] --allow-shell: agent can run any command as %s; %sthe command itself is not confined", name, inRoot))
	}
	scopeRoot := ""
	if !whole {
		scopeRoot = base
	}
	ex := exec.New(exec.Scope{Root: scopeRoot, Base: base, AllowShell: *allowShell, ShellTimeoutMs: timeout, Log: logf})

	// new WebSocket (in TS's runNode, after the log lines above) runs Node's
	// validateHeaderName / Value per header and throws: exit 1, no retry.
	for _, name := range hdrNames {
		if !httpToken(name) {
			fail(fmt.Sprintf("Header name must be a valid HTTP token [\"%s\"]", name))
		}
		if !headerValue(hdrVals[name]) {
			fail(fmt.Sprintf("Invalid character in header content [\"%s\"]", name))
		}
	}

	stop := make(chan struct{})
	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; close(stop) }()
	code, err := client.Run(client.Options{Server: *server, Token: tok, Headers: hdr, Host: host, Info: info, Exec: ex, Log: logf}, stop)
	if err != nil {
		fail(err.Error())
	}
	os.Exit(code)
}
