package jsv

import (
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestUnits16ExactCapacity(t *testing.T) {
	for _, c := range []struct {
		input string
		want  []rune
	}{
		{"", []rune{}}, {"abc", []rune{'a', 'b', 'c'}},
		{"é中", []rune{0xe9, 0x4e2d}},
		{"a😀😁z", []rune{'a', 0xd83d, 0xde00, 0xd83d, 0xde01, 'z'}},
		{"\xff😀", []rune{0xfffd, 0xd83d, 0xde00}},
	} {
		got := Units16(c.input)
		if !slices.Equal(got, c.want) || cap(got) != len(c.want) {
			t.Errorf("Units16(%q) = %x len=%d cap=%d, want %x", c.input, got, len(got), cap(got), c.want)
		}
	}
	input := strings.Repeat("😀", 1<<18) // 1 MiB UTF-8 -> 2 MiB rune units, not 4 MiB
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	got := Units16(input)
	runtime.ReadMemStats(&after)
	if n := after.TotalAlloc - before.TotalAlloc; n > 2<<20+64<<10 {
		t.Errorf("Units16 allocated %d bytes, want ~2 MiB", n)
	}
	runtime.KeepAlive(got)
}
