//go:build !windows

package exec

import (
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"io"
	"strings"
	"sync"
	"sync/atomic"
)

type outBuf struct {
	mu    sync.Mutex
	dec   jsv.Decoder
	sb    strings.Builder
	n16   int
	over  func()
	crash atomic.Pointer[any] // a panic in pump; mu may still be held then
}

func (b *outBuf) pump(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	defer func() {
		if p := recover(); p != nil { // stop reading, stop the command; spawnGroup re-panics
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
