package exec

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
	"unsafe"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

const readHardLimit = 2 * 1024 * 1024

// ioMaxLength is Node's kIoMaxLength: fs.readFile refuses a bigger regular file before reading.
const ioMaxLength = 1<<31 - 1

// v8StringMax is V8's String::kMaxLength in UTF-16 units (Node's
// buffer.constants.MAX_STRING_LENGTH): (1<<29)-24 on 64-bit, (1<<28)-16 on
// 32-bit. A var so tests can lower it.
var v8StringMax int64 = 1<<29 - 24

func init() {
	if strconv.IntSize == 32 {
		v8StringMax = 1<<28 - 16
	}
}

// errStringLength is the RangeError fs.readFile throws once the decoded text
// passes v8StringMax.
var errStringLength = errors.New("Invalid string length")

// readFile is fs.readFile(p, 'utf-8') with Node's error text. Capped at
// v8StringMax bytes — a UTF-8 byte never decodes to more than one UTF-16
// unit, so below that Node never throws; above it Node may still fit a
// mostly multi-byte file, Go refuses it (D13).
func readFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", jsv.FsError(err, "open", p)
	}
	defer f.Close()
	size := int64(0)
	if st, err := f.Stat(); err == nil {
		// Windows ReadFile on a directory yields ERROR_INVALID_FUNCTION;
		// recognize the directory at the file boundary, like Node readFile.
		if st.IsDir() {
			return "", jsv.FsError(syscall.EISDIR, "read", "")
		}
		if st.Mode().IsRegular() {
			size = st.Size()
		}
	}
	if size > ioMaxLength {
		return "", fmt.Errorf("File size (%d) is greater than 2 GiB", size)
	}
	if size > v8StringMax {
		return "", errStringLength
	}
	// os.ReadFile's loop, with the cap: size 0 (a device, a pipe, procfs) reads
	// until EOF, the buffer never growing past v8StringMax+1 (/dev/zero stops there).
	b := make([]byte, 0, max(size+1, 512))
	for {
		n, err := f.Read(b[len(b):cap(b)])
		b = b[:len(b)+n]
		if int64(len(b)) > v8StringMax {
			return "", errStringLength
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", jsv.FsError(err, "read", "")
		}
		if len(b) == cap(b) {
			nb := make([]byte, len(b), min(2*int64(cap(b)), v8StringMax+1))
			copy(nb, b)
			b = nb
		}
	}
	if utf8.Valid(b) {
		return unsafe.String(unsafe.SliceData(b), len(b)), nil // b is never written again: no second copy of the file
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
