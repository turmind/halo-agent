//go:build windows

package exec

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestWindowsDelayedExpansionDefault(t *testing.T) {
	// HKCU overrides the machine default. Restore it after testing both values;
	// tests are deliberately not parallel while this process-wide default changes.
	key, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Command Processor`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()
	old, _, oldErr := key.GetIntegerValue("DelayedExpansion")
	if oldErr != nil && !errors.Is(oldErr, registry.ErrNotExist) {
		t.Fatal(oldErr)
	}
	defer func() {
		var err error
		if oldErr == nil {
			err = key.SetDWordValue("DelayedExpansion", uint32(old))
		} else {
			err = key.DeleteValue("DelayedExpansion")
		}
		if err != nil {
			t.Error(err)
		}
	}()
	t.Setenv("HALO_TEST_EXPAND", "expanded")
	root := t.TempDir()
	for _, enabled := range []uint32{0, 1} {
		if err := key.SetDWordValue("DelayedExpansion", enabled); err != nil {
			t.Fatal(err)
		}
		want := "!HALO_TEST_EXPAND! 100%\r\n"
		if enabled == 1 {
			want = "expanded 100%\r\n"
		}
		out, stderr, msg, aborted := spawnGroup(context.Background(), "echo !HALO_TEST_EXPAND! 100%", root, 10000)
		if out != want || stderr != "" || msg != "" || aborted {
			t.Errorf("DelayedExpansion=%d: out=%q stderr=%q msg=%q aborted=%v", enabled, out, stderr, msg, aborted)
		}
	}
}
