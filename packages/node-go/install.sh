#!/bin/sh
# halo-node installer: curl -fsSL https://github.com/turmind/halo-agent/releases/download/v<ver>/install.sh | sh
# Installs the halo-node binary of this release (Linux / macOS, SHA256-checked) into /usr/local/bin
# (root) or ~/.local/bin, replacing any previous one in place. Re-run to upgrade. POSIX sh.
set -eu

VERSION=__HALO_VERSION__ # the release workflow stamps the tag (minus "v") here before uploading
BASE="https://github.com/turmind/halo-agent/releases/download/v$VERSION"

say() { printf '%s\n' "$*"; }
die() { printf 'halo-node install: %s\n' "$*" >&2; exit 1; }

# All work happens in main, called on the last line: a download cut short by
# `curl | sh` defines nothing and runs nothing.
main() {
  case "$(uname -s)" in
    Linux)
      OS=linux
      case "$(uname -m)" in
        x86_64) ARCH=amd64 ;;
        aarch64 | arm64) ARCH=arm64 ;;
        armv7l | armv8l) ARCH=armv7 ;;
        *) die "unsupported architecture: $(uname -m) (halo-node is built for x86_64, arm64, armv7)" ;;
      esac
      ;;
    Darwin)
      OS=darwin
      case "$(uname -m)" in
        arm64) ARCH=arm64 ;;
        x86_64) ARCH=amd64 ;;
        *) die "unsupported architecture: $(uname -m) (halo-node for macOS is built for arm64, x86_64)" ;;
      esac
      ;;
    *) die "no halo-node build for $(uname -s) — on Windows download halo-node-windows-amd64.exe from $BASE" ;;
  esac
  ASSET="halo-node-$OS-$ARCH"

  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
  else
    die "needs curl or wget"
  fi

  if [ "$(id -u)" -eq 0 ]; then
    DIR=/usr/local/bin
  else
    [ -n "${HOME:-}" ] || die "HOME is not set — set it (installs to \$HOME/.local/bin), or run as root for /usr/local/bin"
    DIR="$HOME/.local/bin"
  fi
  mkdir -p "$DIR"

  # Temp files sit in the target dir, so the final mv is an atomic rename: a running
  # halo-node keeps its old inode (no "Text file busy"). Their names are fixed before
  # the trap and the files are only created after it, so no interruption leaves one
  # behind. The dir is writable only by its owner, so a predictable name is fine.
  TMP="$DIR/.halo-node.$$.tmp"
  SUMS="$DIR/.halo-node.$$.sums"
  trap 'rm -f "$TMP" "$SUMS"' EXIT
  trap 'exit 1' HUP INT PIPE TERM

  say "Downloading $ASSET $VERSION ..."
  fetch "$BASE/$ASSET" "$TMP" || die "download failed: $BASE/$ASSET"
  fetch "$BASE/SHA256SUMS" "$SUMS" || die "download failed: $BASE/SHA256SUMS"

  WANT=$(awk -v f="$ASSET" '$2 == f { print $1 }' "$SUMS")
  [ -n "$WANT" ] || die "$ASSET is not listed in SHA256SUMS"
  NOSUM=
  if command -v sha256sum >/dev/null 2>&1; then
    GOT=$(sha256sum "$TMP" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    GOT=$(shasum -a 256 "$TMP" | awk '{ print $1 }')
  else
    NOSUM=1
    say "warning: no sha256sum or shasum — skipping the checksum check" >&2
  fi
  if [ -z "$NOSUM" ]; then
    # awk exits 0 even when the hash tool failed: an empty hash is a failure, not a skip.
    [ -n "$GOT" ] || die "could not compute the SHA256 of $ASSET"
    [ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET (expected $WANT, got $GOT)"
  fi

  chmod 755 "$TMP"
  # Smoke test before replacing anything (also the only check when no hash tool exists).
  RAN=$("$TMP" --version 2>/dev/null) || die "the downloaded $ASSET does not run here (--version failed); nothing was replaced"
  mv -f "$TMP" "$DIR/halo-node"
  say "Installed $DIR/halo-node ($RAN)"

  case ":$PATH:" in
    *":$DIR:"*) RUN=halo-node ;;
    *)
      RUN="$DIR/halo-node"
      say "$DIR is not in PATH — run it as $RUN, or add $DIR to PATH."
      ;;
  esac
  say "Next: get a token in Admin → Channels → Linked machines, then run"
  say "  HALO_NODE_TOKEN=<token> $RUN --server <server url> --root <folder>"
}

main "$@"
