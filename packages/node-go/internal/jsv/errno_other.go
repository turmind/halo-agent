//go:build !linux && !windows

package jsv

// errnoText is Linux-only (errno numbers differ per OS): on macOS FsError falls
// back to `Unknown system error -<n>` (accepted; darwin builds are cross-compiled only).
var errnoText = map[uint32][2]string{}
