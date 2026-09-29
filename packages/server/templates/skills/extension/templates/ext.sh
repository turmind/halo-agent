#!/usr/bin/env bash
# Install / list / remove admin preview extensions under ~/.halo/global/extensions/.
# The directory IS the install: the server watches the root and pushes changes
# to every open admin, so nothing here talks to the server. Validation
# authority is the server's scanner; this script only pre-checks the required
# fields so a broken package never replaces a working install.
#
#   ext.sh install <id | path/to.zip | https://…zip>
#   ext.sh list
#   ext.sh remove <id>
#
# Needs curl + unzip + node. No `gh`: releases are read through the public API
# (GITHUB_TOKEN, if set, is sent to lift the 60 req/h anonymous limit).
set -euo pipefail

ROOT="$HOME/.halo/global/extensions"
REPO="turmind/halo-hub"
ID_RE='^[a-z0-9][a-z0-9_-]{0,63}$'   # keep in sync with server extensions/registry.ts ID_RE

cmd=${1:?usage: ext.sh install <id|zip|url> | list | remove <id>}
shift || true

# Print `<id> <version> <name>` for the extension dir $1, or fail with the
# reason. $2 (optional) = the id the directory / request claims.
precheck() {
  node -e '
    const fs = require("fs"), dir = process.argv[1], expect = process.argv[2] || ""
    const fail = (msg) => { console.log(msg); process.exit(1) }
    let m
    try { m = JSON.parse(fs.readFileSync(dir + "/halo-extension.json", "utf8")) } catch (e) { fail("halo-extension.json missing or invalid: " + e.message) }
    for (const k of ["id", "name", "version", "extensions", "entry"]) if (!m[k]) fail("missing " + k)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id)) fail("bad id: " + m.id)
    if (expect && m.id !== expect) fail("manifest id \"" + m.id + "\" != \"" + expect + "\"")
    let isFile = false
    try { isFile = fs.statSync(dir + "/" + m.entry).isFile() } catch {}
    if (!isFile) fail("entry not found: " + m.entry)
    console.log(m.id + " " + m.version + " " + m.name)
  ' "$1" "${2:-}"
}

# Echo the path of a local zip for source $1 (path, https URL, or hub id).
resolve_source() {
  local src=$1 url
  if [[ -f $src ]]; then echo "$src"; return; fi
  if [[ $src =~ ^https?:// ]]; then curl -fsSL "$src" -o "$TMP/pkg.zip"; echo "$TMP/pkg.zip"; return; fi
  [[ $src =~ $ID_RE ]] || { echo "invalid id or missing file: $src" >&2; exit 1; }
  # Newest non-draft, non-prerelease release tagged "<id>-v*" (API is newest-first).
  url=$(curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
        "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | node -e '
        let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
          const id = process.argv[1]
          const r = JSON.parse(s).find((r) => r.tag_name.startsWith(id + "-v") && !r.draft && !r.prerelease)
          const a = r && r.assets.find((a) => a.name.endsWith(".zip"))
          if (!a) process.exit(2)
          console.log(a.browser_download_url)
        })' "$src") \
    || { echo "no release for $src in $REPO — download the zip from https://github.com/$REPO/releases and run: install <path>" >&2; exit 1; }
  curl -fsSL "$url" -o "$TMP/pkg.zip"
  echo "$TMP/pkg.zip"
}

case $cmd in
  install)
    src=${1:?usage: ext.sh install <id|zip|url>}
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    zip=$(resolve_source "$src")
    # Same refusals as the server's zip installer: no `..`, no absolute paths,
    # no symlinks (zipinfo mode column starts with `l`).
    if unzip -Z1 "$zip" | grep -Eq '(^|/)\.\.(/|$)|^/'; then echo "zip contains ../ or absolute entries" >&2; exit 1; fi
    if unzip -Z "$zip" | grep -q '^l'; then echo "zip contains symlinks" >&2; exit 1; fi
    mkdir -p "$TMP/x"
    unzip -q "$zip" -d "$TMP/x"
    # `zip -r glb.zip glb/` wraps everything in one directory — descend into it.
    dir="$TMP/x"
    if [[ ! -f $dir/halo-extension.json ]]; then
      only=$(find "$dir" -mindepth 1 -maxdepth 1 | head -2)
      if [[ $(printf '%s\n' "$only" | wc -l) -eq 1 && -f $only/halo-extension.json ]]; then dir=$only; fi
    fi
    expect=""
    if [[ $src =~ $ID_RE && ! -f $src ]]; then expect=$src; fi
    if ! out=$(precheck "$dir" "$expect"); then echo "invalid extension: $out" >&2; exit 1; fi
    read -r id ver _ <<<"$out"
    mkdir -p "$ROOT"
    stage="$ROOT/.tmp-$id-$RANDOM$RANDOM"
    mv "$dir" "$stage"
    old=""
    if [[ -d $ROOT/$id ]]; then old="$ROOT/.old-$id-$RANDOM$RANDOM"; mv "$ROOT/$id" "$old"; fi
    mv "$stage" "$ROOT/$id" || { [[ -n $old ]] && mv "$old" "$ROOT/$id"; rm -rf "$stage"; exit 1; }
    if [[ -n $old ]]; then rm -rf "$old"; fi
    echo "installed $id $ver" ;;
  list)
    shopt -s nullglob
    n=0
    for d in "$ROOT"/*/; do
      d=${d%/}; id=$(basename "$d"); n=$((n + 1))
      if out=$(precheck "$d" "$id"); then
        read -r _ ver name <<<"$out"; printf '%s\t%s\t%s\n' "$id" "$ver" "$name"
      else
        printf '%s\tERROR\t%s\n' "$id" "$(printf '%s' "$out" | head -1)"
      fi
    done
    if [[ $n -eq 0 ]]; then echo "(none)"; fi ;;
  remove)
    id=${1:?usage: ext.sh remove <id>}
    [[ $id =~ $ID_RE ]] || { echo "invalid id: $id" >&2; exit 1; }
    [[ -d $ROOT/$id ]] || { echo "not installed: $id" >&2; exit 1; }
    rm -rf "$ROOT/$id"
    echo "removed $id" ;;
  *)
    echo "unknown command: $cmd (install | list | remove)" >&2; exit 1 ;;
esac
