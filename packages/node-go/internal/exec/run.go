package exec

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
)

const (
	killGrace   = 2000 * time.Millisecond
	forceSettle = 200 * time.Millisecond
	maxBuffer   = 5 * 1024 * 1024 // general.limits.shell_output_bytes default (D8)
)

var paramsRe = regexp.MustCompile(`\{\{\s*([\w-]+)\.params\.([\w-][\w.-]*)\s*\}\}`)

// child-env.ts cleanChildEnv.
var strippedEnv = map[string]bool{
	"HALO_PASSWORD": true, "HALO_JWT_SECRET": true, "HALO_NODE_TOKEN": true,
}

func cleanEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if !strippedEnv[k] {
			out = append(out, kv)
		}
	}
	return out
}

func (e *Executor) prepareRun(args map[string]any) (call, error) {
	if !e.s.AllowShell {
		return nil, &refusal{ShellDisabled, "shell disabled"}
	}
	command, _ := jsv.Get(args, "command").(string)
	if jsv.Trim(command) == "" {
		return nil, errors.New("`command` is required")
	}
	cwdArg := str(jsv.Get(args, "cwd"), ".")
	placed, err := e.place(cwdArg)
	if err != nil {
		return nil, err
	}
	cwd := nodepath.Resolve(e.s.Base, placed)
	if !isDir(cwd) {
		return nil, fmt.Errorf("cwd \"%s\" is not a directory on this machine", cwdArg)
	}
	return func(ctx context.Context) (string, error) { return e.run(ctx, command, cwd) }, nil
}

// shell_exec at full access (runShellExec → sandboxExec → spawnGroupExec).
func (e *Executor) run(ctx context.Context, command, cwd string) (string, error) {
	cmd := jsv.Trim(command)
	// Empty allowed-namespace set: placeholders stay literal, one log line each.
	for _, m := range paramsRe.FindAllStringSubmatch(cmd, -1) {
		e.s.Log(fmt.Sprintf("[WorkspaceTools] {{%s.params.%s}} rejected — namespace not in allowed list", m[1], m[2]))
	}
	// assertRmSafe: cwd is the tools' workspaceRoot as-is (no realpath, like TS).
	if err := checkCommand(cmd, cwd); err != nil {
		return toolError + "\nCommand failed: " + err.Error() + "\n\n", nil
	}

	stdout, stderr, msg, aborted := spawnGroup(ctx, cmd, cwd, e.s.ShellTimeoutMs)
	if aborted {
		return "", errors.New("The operation was aborted") // never sent: the call was cancelled
	}
	if msg == "" {
		out := stdout
		if stderr != "" {
			out += "\nSTDERR: " + stderr
		}
		if out = jsv.Trim(out); out == "" {
			return "(no output)", nil
		}
		return out, nil
	}
	return toolError + "\nCommand failed: " + msg + "\n" + stdout + "\n" + stderr, nil
}

// testPumpChunk, when set, runs on every chunk under mu (tests inject a panic).
var testPumpChunk func()

// spawnGroup runs the platform shell in a process group / job. msg is ""
// on exit 0, else the error message; aborted = the ctx was cancelled.
func spawnGroup(ctx context.Context, cmd, cwd string, timeoutMs int64) (stdout, stderr, msg string, aborted bool) {
	c := shellCommand(cmd)
	c.Dir = cwd
	// stdin: a pipe nobody writes or closes (Node's default 'pipe'): `cat` waits.
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return "", "", err.Error(), false
	}
	defer stdinW.Close()
	c.Stdin = stdinR
	outR, outW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		return "", "", err.Error(), false
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		outR.Close()
		outW.Close()
		return "", "", err.Error(), false
	}
	c.Stdout, c.Stderr = outW, errW
	stop, closeGroup, err := startGroup(c)
	if err != nil {
		stdinR.Close()
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return "", "", err.Error(), false
	}
	stdinR.Close()
	outW.Close()
	errW.Close()
	defer closeGroup()
	defer outR.Close()
	defer errR.Close()

	var mu sync.Mutex
	killReason := ""
	var escalation *time.Timer
	settleNow := make(chan struct{})
	var settleOnce sync.Once
	escalate := func(reason string) {
		mu.Lock()
		defer mu.Unlock()
		killReason = reason
		stop(false)
		if escalation != nil {
			return
		}
		escalation = time.AfterFunc(killGrace, func() {
			stop(true)
			time.AfterFunc(forceSettle, func() { settleOnce.Do(func() { close(settleNow) }) })
		})
	}

	var so, se outBuf
	so.over = func() { escalate("timeout") }
	se.over = so.over
	var wg sync.WaitGroup
	wg.Add(2)
	go so.pump(outR, &wg)
	go se.pump(errR, &wg)

	// 'close': process exited AND both pipes hit EOF.
	closed := make(chan error, 1)
	go func() {
		wg.Wait()
		closed <- c.Wait()
	}()
	var timer <-chan time.Time
	if timeoutMs != 0 { // `opts.timeout ? … : null`
		d := timeoutMs
		if d < 1 || d > math.MaxInt32 { // Node setTimeout: out-of-range delays run after 1ms
			d = 1
		}
		t := time.NewTimer(time.Duration(d) * time.Millisecond)
		defer t.Stop()
		timer = t.C
	}
	done := ctx.Done()
	var waitErr error
	forced := false
loop:
	for {
		select {
		case waitErr = <-closed:
			break loop
		case <-timer:
			timer = nil
			escalate("timeout")
		case <-done:
			done = nil
			escalate("abort")
		case <-settleNow:
			forced = true
			break loop
		}
	}
	mu.Lock()
	if escalation != nil {
		escalation.Stop()
	}
	reason := killReason
	mu.Unlock()
	if forced { // escaped group: stop reading, the pipes may never close
		outR.Close()
		errR.Close()
	}
	for _, b := range []*outBuf{&so, &se} {
		if p := b.crash.Load(); p != nil {
			outR.Close()
			errR.Close()
			panic(*p) // before String(): mu may be held. The call goroutine reports it.
		}
	}
	stdout, stderr = so.String(), se.String()
	switch {
	case reason == "abort":
		return stdout, stderr, "The operation was aborted", true
	case reason == "timeout":
		return stdout, stderr, fmt.Sprintf("Command timed out after %dms", timeoutMs), false
	case waitErr == nil && !forced:
		return stdout, stderr, "", false
	}
	return stdout, stderr, "Command failed: " + cmd, false
}
