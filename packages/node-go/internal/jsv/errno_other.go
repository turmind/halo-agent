//go:build !linux && !windows

package jsv

// errnoText is Linux-only (errno numbers differ per OS; release builds are Linux).
var errnoText = map[uint32][2]string{}
