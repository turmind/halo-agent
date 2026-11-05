package client

import "testing"

func TestWSURL(t *testing.T) {
	for _, c := range []struct{ in, want, err string }{
		{"http://h:9527", "ws://h:9527/api/nodes/connect", ""},
		{"https://h/x/", "wss://h/x/api/nodes/connect", ""},
		{"https://h/x///?q=1#f", "wss://h/x/api/nodes/connect", ""},
		{"ws://h", "ws://h/api/nodes/connect", ""},
		{"wss://h:1/p", "wss://h:1/p/api/nodes/connect", ""},
		{"ftp://x", "", "--server must be http(s):// or ws(s)://, got ftp://x"},
		{"localhost:9527", "", "--server must be http(s):// or ws(s)://, got localhost:9527"},
		{"http//x", "", "Invalid URL"},
	} {
		got, err := WSURL(c.in)
		if c.err != "" {
			if err == nil || err.Error() != c.err {
				t.Errorf("%q: err %v, want %q", c.in, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	if u := uuid4(); len(u) != 36 || u[14] != '4' {
		t.Errorf("uuid4 %q", u)
	}
}
