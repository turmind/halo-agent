package protocol

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The constants here are hand-mirrored from the server's protocol.ts; this
// reads that file and fails when a value drifts.
func TestMirrorsProtocolTS(t *testing.T) {
	src, err := os.ReadFile("../../../server/src/nodes/protocol.ts")
	if err != nil {
		t.Fatal(err)
	}
	ts := string(src)
	val := func(name string) string {
		m := regexp.MustCompile(`(?m)^export const ` + name + `(?:: [^=]+)? = (.+)$`).FindStringSubmatch(ts)
		if m == nil {
			t.Fatalf("protocol.ts: no export const %s", name)
		}
		return strings.TrimSpace(m[1])
	}
	str := func(name string) string {
		v := val(name)
		s, ok := strings.CutPrefix(v, "'")
		if s, ok = strings.CutSuffix(s, "'"); !ok {
			t.Fatalf("%s = %s: not a string literal", name, v)
		}
		return s
	}
	num := func(name string) int { // an integer literal or a product of them (8 * 1024)
		n := 1
		for _, f := range strings.Split(val(name), "*") {
			k, err := strconv.Atoi(strings.TrimSpace(f))
			if err != nil {
				t.Fatalf("%s = %s: not an integer product", name, val(name))
			}
			n *= k
		}
		return n
	}

	for _, c := range []struct {
		name    string
		ts, gov any
	}{
		{"NODE_WS_PATH", str("NODE_WS_PATH"), WSPath},
		{"HEADER_PROTOCOL", str("HEADER_PROTOCOL"), HeaderProtocol},
		{"HEADER_INSTANCE", str("HEADER_INSTANCE"), HeaderInstance},
		{"HEADER_INFO", str("HEADER_INFO"), HeaderInfo},
		{"NODE_PROTOCOL", num("NODE_PROTOCOL"), Version},
		{"MAX_FRAME_BYTES", num("MAX_FRAME_BYTES"), MaxFrameBytes},
		{"NODE_RESULT_MAX_CHARS", num("NODE_RESULT_MAX_CHARS"), ResultMaxChars},
		{"CLOSE_REVOKED", num("CLOSE_REVOKED"), CloseRevoked},
		{"CLOSE_REPLACED", num("CLOSE_REPLACED"), CloseReplaced},
	} {
		if c.ts != c.gov {
			t.Errorf("protocol.ts %s = %v, Go has %v", c.name, c.ts, c.gov)
		}
	}

	m := regexp.MustCompile(`new Set<NodeOp>\(\[([^\]]*)\]\)`).FindStringSubmatch(val("NODE_OPS"))
	if m == nil {
		t.Fatalf("NODE_OPS = %s: not new Set<NodeOp>([...])", val("NODE_OPS"))
	}
	var tsOps, goOps []string
	for _, q := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(m[1], -1) {
		tsOps = append(tsOps, q[1])
	}
	for op := range Ops {
		goOps = append(goOps, op)
	}
	slices.Sort(tsOps)
	slices.Sort(goOps)
	if !slices.Equal(tsOps, goOps) {
		t.Errorf("protocol.ts NODE_OPS %v, Go Ops %v", tsOps, goOps)
	}
}
