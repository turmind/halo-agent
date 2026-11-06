#!/bin/sh
# Linux + Windows release binaries and SHA256SUMS into dist/. VER defaults to dev-<shortsha>.
set -e
cd "$(dirname "$0")"
VER=${VER:-dev-$(git rev-parse --short HEAD)}
LDF="-s -w -X main.version=$VER"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64       go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-amd64 ./cmd/halo-node
CGO_ENABLED=0 GOOS=linux GOARCH=arm64       go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-arm64 ./cmd/halo-node
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-armv7 ./cmd/halo-node
CGO_ENABLED=0 GOOS=windows GOARCH=amd64     go build -trimpath -ldflags "$LDF" -o dist/halo-node-windows-amd64.exe ./cmd/halo-node
(cd dist && sha256sum halo-node-linux-* halo-node-windows-amd64.exe > SHA256SUMS)
