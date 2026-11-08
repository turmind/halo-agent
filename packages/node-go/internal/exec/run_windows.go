//go:build windows

package exec

import (
	"os"
	osexec "os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The POSIX rm guard is not applied on Windows (as sandbox.ts on win32).
func checkCommand(cmd, cwd string) error { return nil }

func shellCommand(cmd string) *osexec.Cmd {
	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = "cmd.exe"
	}
	c := osexec.Command(shell)
	c.Env = append(cleanEnv(), "HALO_NODE_COMMAND="+cmd)
	// cmd caches its output codepage at startup. Start a second cmd after chcp
	// in the hidden console; pass Unicode via the environment so the bootstrap
	// parser cannot lose it. Delayed expansion inserts metacharacters verbatim,
	// and the inner /s /c parses the user's command exactly once (D17).
	c.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: syscall.EscapeArg(shell) + ` /d /v:on /s /c "chcp 65001 >nul 2>&1 & "` + shell + `" /d /s /c "!HALO_NODE_COMMAND!""`,
		// chcp needs a console even under Task Scheduler. Hide a new console,
		// rather than CREATE_NO_WINDOW (which silently leaves echo in OEM).
		CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NEW_CONSOLE,
		HideWindow:    true,
	}
	return c
}

// c uses file handles, not os/exec copy goroutines: Wait observes shell exit
// independently of pipe EOF. Close the job first so inherited pipes can drain.
func waitGroup(c *osexec.Cmd, pumps *sync.WaitGroup, closeGroup func()) error {
	err := c.Wait()
	closeGroup()
	pumps.Wait()
	return err
}

func startGroup(c *osexec.Cmd) (stop func(bool), closeGroup func(), err error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, nil, err
	}
	var mu sync.Mutex
	closeGroup = func() {
		mu.Lock()
		defer mu.Unlock()
		if job != 0 {
			_ = windows.CloseHandle(job)
			job = 0
		}
	}
	defer func() {
		if err != nil {
			closeGroup()
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, closeGroup, err
	}
	if err = c.Start(); err != nil {
		return nil, closeGroup, err
	}
	// No user code runs until assignment succeeds: otherwise a fast child could
	// spawn outside the job between Start and AssignProcessToJobObject.
	defer func() {
		if err != nil {
			_ = c.Process.Kill()
			_ = c.Wait()
		}
	}()
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(c.Process.Pid))
	if err != nil {
		return nil, closeGroup, err
	}
	defer windows.CloseHandle(process)
	if err = windows.AssignProcessToJobObject(job, process); err != nil {
		return nil, closeGroup, err
	}
	if err = resumeProcess(uint32(c.Process.Pid)); err != nil {
		return nil, closeGroup, err
	}
	// Windows has no SIGTERM for a hidden cmd tree. Terminate the job on both
	// stages; the common loop retains killGrace / forceSettle and result text.
	return func(bool) {
		mu.Lock()
		defer mu.Unlock()
		if job != 0 {
			_ = windows.TerminateJobObject(job, 1)
		}
	}, closeGroup, nil
}

// os/exec closes the primary thread handle. Find it using documented Win32
// APIs while the process is still suspended (no child threads can run yet).
func resumeProcess(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		return err
	}
	return err
}
