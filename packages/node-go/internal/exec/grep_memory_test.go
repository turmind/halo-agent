package exec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/protocol"
)

func TestGrepLongLiteralLine(t *testing.T) {
	ex, root, _ := newEx(t)
	line := strings.Repeat("a", 1<<20) + "😀needle"
	if err := os.WriteFile(filepath.Join(root, "long.txt"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, pattern := range []string{"absent", "needle", "😀", "😁"} {
		var got string
		n := allocated(func() { got = run1(ex, "grep", map[string]any{"path": "long.txt", "pattern": pattern}) })
		want := "No matches found for pattern \"" + pattern + "\""
		limit := uint64(2 << 20)
		if strings.Contains(line, pattern) {
			full := "long.txt:1:" + line
			want = jsv.Truncate16(full, protocol.ResultMaxChars) + "\n[Content truncated on the machine: 1048595 chars total]"
			limit = 4 << 20
		}
		if got != want {
			t.Errorf("%q result: len=%d want len=%d", pattern, len(got), len(want))
		}
		if n > limit {
			t.Errorf("%q allocated %d bytes, limit %d", pattern, n, limit)
		}
	}
}
