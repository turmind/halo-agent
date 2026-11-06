//go:build !windows

package exec

import (
	osexec "os/exec"
	"syscall"

	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
	"github.com/turmind/halo-agent/packages/node-go/internal/rmguard"
)

func checkCommand(cmd, cwd string) error {
	return rmguard.Check(cmd, cwd, nodepath.Home())
}

func shellCommand(cmd string) *osexec.Cmd {
	c := osexec.Command("/bin/sh", "-c", cmd)
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return c
}

func startGroup(c *osexec.Cmd) (stop func(bool), closeGroup func(), err error) {
	if err := c.Start(); err != nil {
		return nil, nil, err
	}
	return func(hard bool) {
		sig := syscall.SIGTERM
		if hard {
			sig = syscall.SIGKILL
		}
		_ = syscall.Kill(-c.Process.Pid, sig)
	}, func() {}, nil
}
