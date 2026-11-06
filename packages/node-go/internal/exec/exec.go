// Package exec is node-exec.ts + the slice of workspace-tools.ts / sandbox.ts
// it delegates to (full access): one request in, the exact text (or error
// message) the TS node would send back.
package exec

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
	"github.com/turmind/halo-agent/packages/node-go/internal/protocol"
)

const (
	toolWarn  = "__TOOL_WARN__"
	toolError = "__TOOL_ERROR__"
)

// ShellDisabled is node-exec.ts SHELL_DISABLED (kept verbatim, §9 Q16).
const ShellDisabled = "node_run is disabled on this machine — the user must restart `halo node` with --allow-shell to allow commands"

// Scope: Root "" = whole-machine mode. Base = where relative paths resolve.
type Scope struct {
	Root           string
	Base           string
	AllowShell     bool
	ShellTimeoutMs int64
	Log            func(string)
}

// Executor runs one request.
type Executor struct{ s Scope }

// New builds an executor for scope.
func New(s Scope) *Executor { return &Executor{s} }

// refusal is a request the machine turned down (logged as `refused`).
type refusal struct{ msg, reason string }

func (r *refusal) Error() string { return r.msg }

func str(v any, d string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return d
}

func label(op string, args map[string]any) string {
	if op == "run" {
		return fmt.Sprintf("run (cwd %s): %s", str(jsv.Get(args, "cwd"), "."), str(jsv.Get(args, "command"), ""))
	}
	pattern := ""
	if op == "grep" || op == "glob" {
		p := jsv.Get(args, "pattern")
		if jsv.IsNullish(p) {
			p = ""
		}
		pattern = " " + jsv.Stringify(p)
	}
	return op + " " + str(jsv.Get(args, "path"), ".") + pattern
}

// place: the path to hand the tool; refuses paths outside the root.
func (e *Executor) place(p string) (string, error) {
	plain := nodepath.Resolve(e.s.Base, p)
	var full string
	if e.s.Root == "" {
		full = nodepath.WholePath(e.s.Base, p)
		if full == "" {
			return "", &refusal{fmt.Sprintf("%q is not a supported path on this machine — node tools cannot use Windows namespace paths or components ending in a dot or space", p), "unsupported path"}
		}
		return p, nil
	}
	full = nodepath.InRoot(e.s.Root, p)
	if full == "" {
		return "", &refusal{fmt.Sprintf("%q is outside this machine's shared folder (%s) — node tools can only reach paths inside it", p, e.s.Root), "outside root"}
	}
	if full == plain {
		return p, nil
	}
	return full, nil
}

type call func(ctx context.Context) (string, error)

func (e *Executor) prepare(op string, args map[string]any) (call, error) {
	if op == "run" {
		return e.prepareRun(args)
	}
	pathArg := jsv.Get(args, "path")
	if _, isStr := pathArg.(string); !isStr && (op == "read" || op == "write" || op == "edit") {
		return nil, errors.New("`path` is required")
	}
	placed, err := e.place(str(pathArg, "."))
	if err != nil {
		return nil, err
	}
	full := nodepath.Resolve(e.s.Base, placed)
	switch op {
	case "read":
		return func(ctx context.Context) (string, error) { return e.read(full, args) }, nil
	case "write":
		return func(ctx context.Context) (string, error) { return e.write(full, placed, args) }, nil
	case "edit":
		return func(ctx context.Context) (string, error) { return e.edit(full, placed, args) }, nil
	case "list":
		return func(ctx context.Context) (string, error) { return e.list(ctx, full, args) }, nil
	case "grep":
		return func(ctx context.Context) (string, error) { return e.grep(ctx, full, args) }, nil
	case "glob":
		return func(ctx context.Context) (string, error) { return e.glob(ctx, full, args) }, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

// Exec runs op. The error's message is what goes into `{ok:false,error}`.
// A panic propagates: the client's call goroutine recovers it (and reply's).
func (e *Executor) Exec(ctx context.Context, op string, args map[string]any) (string, error) {
	lbl := label(op, args)
	c, err := e.prepare(op, args)
	if err != nil {
		var r *refusal
		if errors.As(err, &r) {
			e.s.Log("[Node] refused " + lbl + ": " + r.reason)
		}
		return "", err
	}
	e.s.Log("[Node] " + lbl)
	text, err := c(ctx)
	if err != nil {
		return "", err
	}
	if n := jsv.Len16(text); n > protocol.ResultMaxChars {
		text = jsv.Truncate16(text, protocol.ResultMaxChars) + fmt.Sprintf("\n[Content truncated on the machine: %d chars total]", n)
	}
	return text, nil
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
