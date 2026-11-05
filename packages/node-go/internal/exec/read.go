package exec

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

const readHardLimit = 2 * 1024 * 1024

// readFile is fs.readFile(p, 'utf-8') with Node's error text.
func readFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", jsv.FsError(err, "open", p)
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		return "", jsv.FsError(err, "read", "")
	}
	return jsv.Decode(b), nil
}

func unwrapPathErr(err error) error {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err
	}
	return err
}

func padStart(s string, w int) string {
	if len(s) >= w {
		return s
	}
	return strings.Repeat(" ", w-len(s)) + s
}

// file_read.
func (e *Executor) read(full string, args map[string]any) (string, error) {
	offArg, limArg := jsv.Get(args, "offset"), jsv.Get(args, "limit")
	num := func(v any, d float64) float64 {
		if jsv.IsNullish(v) {
			return d
		}
		return math.Max(1, math.Floor(jsv.ToNumber(v)))
	}
	offset := num(offArg, 1)
	limit := num(limArg, 2000)
	userRange := !jsv.IsNullish(offArg) || !jsv.IsNullish(limArg)

	st, err := os.Stat(full)
	if err != nil {
		return "", jsv.FsError(unwrapPathErr(err), "stat", full)
	}
	if !userRange && st.Size() > readHardLimit {
		return toolWarn + "\n" +
			fmt.Sprintf("Error: file too large to read in full (%s MB).\n", jsv.ToFixed(float64(st.Size())/1024/1024, 1)) +
			"Pass `offset` and `limit` to read a specific range, or use `grep` to locate the section first.", nil
	}
	raw, err := readFile(full)
	if err != nil {
		return "", err
	}
	lines := strings.Split(raw, "\n")
	total := float64(len(lines))
	start := offset - 1
	end := math.Min(total, start+limit)
	if start >= total {
		return fmt.Sprintf("(empty: file has %d lines, offset=%s is past end)", len(lines), jsv.NumberToString(offset)), nil
	}
	if math.IsNaN(start) || math.IsNaN(end) {
		return "", nil // lines.slice(NaN…) is empty and no trailing note fires
	}
	s, en := int(start), int(end)
	width := len(jsv.NumberToString(end))
	var out []string
	for i := s; i < en; i++ {
		out = append(out, padStart(fmt.Sprint(i+1), width)+"\t"+lines[i])
	}
	if en < len(lines) {
		out = append(out, fmt.Sprintf("... %d more line(s) — use `offset=%d` to continue.", len(lines)-en, en+1))
	}
	return strings.Join(out, "\n"), nil
}
