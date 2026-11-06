//go:build windows

package main

// The wire protocol reports Node's process.platform, not Go's GOOS.
const nodeOS = "win32"
