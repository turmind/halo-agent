//go:build !windows

package main

import "runtime"

const nodeOS = runtime.GOOS
