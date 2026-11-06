//go:build windows

package exec

import (
	"bytes"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func decodeWinOutput(b []byte) string {
	if utf8.Valid(b) {
		// TextDecoder strips an initial UTF-8 BOM.
		return strings.TrimPrefix(string(b), "\ufeff")
	}
	s, _ := simplifiedchinese.GBK.NewDecoder().Bytes(b)
	return string(s)
}

// execAsync uses encoding:'buffer' on Windows: cap bytes, then decode the
// complete stream, not each chunk (which could split a GBK / UTF-8 character).
type outBuf struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	over  func()
	crash atomic.Pointer[any]
}

func (b *outBuf) pump(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	defer func() {
		if p := recover(); p != nil {
			b.crash.Store(&p)
			b.over()
		}
	}()
	buf := make([]byte, 64*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			b.mu.Lock()
			if testPumpChunk != nil {
				testPumpChunk()
			}
			remaining := maxBuffer - b.buf.Len()
			b.buf.Write(buf[:min(n, remaining)])
			b.mu.Unlock()
			if n > remaining {
				b.over()
			}
		}
		if err != nil {
			return
		}
	}
}

func (b *outBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return decodeWinOutput(b.buf.Bytes())
}
