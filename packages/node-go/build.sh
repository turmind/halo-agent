#!/bin/sh
# §5.2: the three linux release binaries + SHA256SUMS into dist/. VER defaults to dev-<shortsha>.
set -e
cd "$(dirname "$0")"
VER=${VER:-dev-$(git rev-parse --short HEAD)}
LDF="-s -w -X main.version=$VER"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64       go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-amd64 ./cmd/halo-node
CGO_ENABLED=0 GOOS=linux GOARCH=arm64       go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-arm64 ./cmd/halo-node
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "$LDF" -o dist/halo-node-linux-armv7 ./cmd/halo-node
(cd dist && sha256sum halo-node-linux-* > SHA256SUMS)
