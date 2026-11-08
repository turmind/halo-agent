// Package protocol mirrors packages/server/src/nodes/protocol.ts (wire v1).
package protocol

import (
	"encoding/base64"
	"encoding/json"
)

const (
	WSPath         = "/api/nodes/connect"
	Version        = 1
	MaxFrameBytes  = 8 * 1024 * 1024
	ResultMaxChars = 256 * 1024

	HeaderProtocol = "x-halo-node-protocol"
	HeaderInstance = "x-halo-node-instance"
	HeaderInfo     = "x-halo-node-info"

	CloseRevoked  = 4001
	CloseReplaced = 4009
)

// Ops is NODE_OPS.
var Ops = map[string]bool{"read": true, "write": true, "edit": true, "list": true, "grep": true, "glob": true, "run": true}

// NodeInfo — field order matters: it follows protocol.ts NodeInfo.
type NodeInfo struct {
	Root           *string `json:"root"`
	Base           string  `json:"base"`
	Shell          bool    `json:"shell"`
	ShellTimeoutMs int64   `json:"shellTimeoutMs"`
	OS             string  `json:"os"`
	Hostname       string  `json:"hostname"`
	Version        string  `json:"version"`
}

// EncodeInfo = Buffer.from(JSON.stringify(info)).toString('base64url') (no padding).
func EncodeInfo(info NodeInfo) string {
	raw, _ := json.Marshal(info)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ServerFrame is any server→node frame; fields kept raw so JS typing rules
// (id must be a string, args defaults to {}) are applied by the caller.
type ServerFrame struct {
	T         string          `json:"t"`
	ID        json.RawMessage `json:"id"`
	Op        json.RawMessage `json:"op"`
	Args      json.RawMessage `json:"args"`
	Name      json.RawMessage `json:"name"`
	Workspace json.RawMessage `json:"workspace"`
}
