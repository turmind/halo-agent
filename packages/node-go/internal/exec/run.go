package exec

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	osexec "os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
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
	"HALO_PASSWORD": true, "HALO_JWT_SECRET": true, "HALO_NODE_RELAY_URL": true, "HALO_NODE_RELAY_TOKEN": true, "HALO_NODE_TOKEN": true,
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
	// TODO(M2): port accidental-deletion guard from sandbox.ts assertRmSafe

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

type outBuf struct {
	mu   sync.Mutex
	dec  jsv.Decoder
	sb   strings.Builder
	n16  int
	over func()
}

func (b *outBuf) pump(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, 64*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			b.mu.Lock()
			s := b.dec.Write(buf[:n])
			b.sb.WriteString(s)
			b.n16 += jsv.Len16(s)
			if b.n16 > maxBuffer {
				t := jsv.Truncate16(b.sb.String(), maxBuffer)
				b.sb.Reset()
				b.sb.WriteString(t)
				b.n16 = maxBuffer
				b.mu.Unlock()
				b.over()
			} else {
				b.mu.Unlock()
			}
		}
		if err != nil {
			b.mu.Lock()
			b.sb.WriteString(b.dec.Flush())
			b.mu.Unlock()
			return
		}
	}
}

func (b *outBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

// spawnGroup runs `/bin/sh -c cmd` as its own process-group leader. msg is ""
// on exit 0, else the error message; aborted = the ctx was cancelled.
func spawnGroup(ctx context.Context, cmd, cwd string, timeoutMs int64) (stdout, stderr, msg string, aborted bool) {
	c := osexec.Command("/bin/sh", "-c", cmd)
	c.Dir = cwd
	c.Env = cleanEnv()
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// stdin: a pipe nobody writes or closes (Node's default 'pipe'): `cat` waits.
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return "", "", err.Error(), false
	}
	defer stdinW.Close()
	c.Stdin = stdinR
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	c.Stdout, c.Stderr = outW, errW
	if err := c.Start(); err != nil {
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
	pid := c.Process.Pid

	var mu sync.Mutex
	killReason := ""
	var escalation *time.Timer
	settleNow := make(chan struct{})
	var settleOnce sync.Once
	killGroup := func(sig syscall.Signal) { _ = syscall.Kill(-pid, sig) }
	escalate := func(reason string) {
		mu.Lock()
		defer mu.Unlock()
		killReason = reason
		killGroup(syscall.SIGTERM)
		if escalation != nil {
			return
		}
		escalation = time.AfterFunc(killGrace, func() {
			killGroup(syscall.SIGKILL)
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
