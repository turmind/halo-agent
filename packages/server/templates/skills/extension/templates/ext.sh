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
#   ext.sh models update [--yes]   # hub's newest models-v* zip → halo models install
#   ext.sh models list             # = halo models list
#
# `install <id>` reads `<hub base>/<id>/update.json` — $HALO_HUB_BASE (the
# skill's hub_base param; empty → the GitHub raw `extensions/` dir of
# $HALO_HUB_REPO) — over https only, then the zip it names, checked against
# its sha256, id and version (same protocol as the admin's update check,
# server updates/update-json.ts). `models update` reads $HALO_HUB_REPO (the
# hub_repo param; empty → https://github.com/turmind/halo-hub) through its
# public release API (GITHUB_TOKEN / GITEA_TOKEN / GITLAB_TOKEN, if set, are
# sent — lifts GitHub's 60 req/h anonymous limit).
# Needs curl + unzip + node. No `gh`.
set -euo pipefail

ROOT="$HOME/.halo/global/extensions"
DEFAULT_HUB="https://github.com/turmind/halo-hub"
ID_RE='^[a-z0-9][a-z0-9_-]{0,63}$'   # keep in sync with server extensions/registry.ts ID_RE

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

# ── Hub source ──────────────────────────────────────────────────────────────
# Self-contained hub_* functions (no globals besides DEFAULT_HUB) so a later
# `/skill install` / `/workspace import` can lift them out unchanged.

# Normalize a hub setting: empty / unsubstituted `{{…}}` → default,
# `owner/repo` → GitHub, an existing dir → absolute path, drop trailing `/`.
# A `.git` suffix stays; the API helpers below drop it.
hub_url() {
  local h=${1:-}
  if [[ -z $h || $h == '{{'* ]]; then h=$DEFAULT_HUB; fi
  if [[ $h =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$ ]]; then h="https://github.com/$h"
  elif [[ -d $h ]]; then h=$(cd "$h" && pwd)
  fi
  echo "${h%/}"
}

# curl with the platform's optional token header.
hub_curl() {
  local p=$1; shift
  case $p in
    github) curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$@" ;;
    gitlab) curl -fsSL ${GITLAB_TOKEN:+-H "PRIVATE-TOKEN: $GITLAB_TOKEN"} "$@" ;;
    gitea)  curl -fsSL ${GITEA_TOKEN:+-H "Authorization: token $GITEA_TOKEN"} "$@" ;;
  esac
}

# Repo endpoint of <platform>'s API for hub URL $2.
hub_repo_api() {
  [[ $2 =~ ^(https?://[^/]+)/(.+)$ ]] || return 1
  local base=${BASH_REMATCH[1]} path=${BASH_REMATCH[2]%.git}
  case $1 in
    github) echo "https://api.github.com/repos/$path" ;;
    gitea)  echo "$base/api/v1/repos/$path" ;;
    gitlab) echo "$base/api/v4/projects/${path//\//%2F}" ;;
  esac
}

hub_releases_api() {
  local q='per_page=100'
  if [[ $1 == gitea ]]; then q='limit=50'; fi
  echo "$(hub_repo_api "$1" "$2")/releases?$q"
}

# 0 when the host answers <platform>'s repo endpoint for $2 with JSON.
hub_probe() {
  local api ct
  api=$(hub_repo_api "$1" "$2") || return 1
  ct=$(hub_curl "$1" --max-time 10 -o /dev/null -w '%{content_type}' "$api" 2>/dev/null) || return 1
  [[ $ct == application/json* ]]
}

# github | gitlab | gitea | git (= no release API) for a normalized hub URL.
hub_platform() {
  if [[ ! $1 =~ ^https?://([^/]+)/[^/]+/.+$ ]]; then echo git; return; fi
  case ${BASH_REMATCH[1]} in
    github.com) echo github ;;
    *gitlab*) echo gitlab ;;
    codeberg.org|*gitea*|*forgejo*) echo gitea ;;
    *) if hub_probe gitea "$1"; then echo gitea
       elif hub_probe gitlab "$1"; then echo gitlab
       else echo git; fi ;;
  esac
}

hub_releases_page() {
  if [[ $1 == gitlab ]]; then echo "${2%.git}/-/releases"; else echo "${2%.git}/releases"; fi
}

# stdin = <platform>'s release list (newest-first); print the first `.zip`
# asset URL of the newest non-draft / non-prerelease / non-upcoming release
# tagged `<id>-v*`, exit 2 if there is none.
hub_pick_release() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      const [platform, id] = process.argv.slice(1)
      // "<id>-v<digit>", so id glb never matches a glb-viewer-v… tag.
      const r = JSON.parse(s).find((r) => new RegExp("^" + id + "-v\\d").test(r.tag_name) && !r.draft && !r.prerelease && !r.upcoming_release)
      const assets = !r ? [] : platform === "gitlab"
        ? ((r.assets && r.assets.links) || []).map((l) => ({ name: l.name, url: l.direct_asset_url || l.url }))
        : (r.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }))
      const a = assets.find((a) => String(a.name).endsWith(".zip"))
      if (!a) process.exit(2)
      console.log(a.url)
    })' "$1" "$2"
}

# Download the newest `<id>-v*` release zip of <platform> hub $2 into $4 and
# echo its path. Extra args ($5…) go to every curl (models pass
# `--proto =https --proto-redir =https`).
hub_fetch_release() {
  local platform=$1 hub=$2 id=$3 tmp=$4 api url token page
  shift 4
  api=$(hub_releases_api "$platform" "$hub")
  page=$(hub_releases_page "$platform" "$hub")
  case $platform in github) token=GITHUB_TOKEN ;; gitlab) token=GITLAB_TOKEN ;; *) token=GITEA_TOKEN ;; esac
  hub_curl "$platform" "$@" "$api" -o "$tmp/releases.json" \
    || { echo "$platform release API failed for $hub — rate-limited, private or wrong repo? set $token, or download the zip from $page and run: install <path>" >&2; exit 1; }
  url=$(hub_pick_release "$platform" "$id" <"$tmp/releases.json") \
    || { echo "no release for $id in $hub — check the id, or download the zip from $page and run: install <path>" >&2; exit 1; }
  # No token here: asset links redirect to other hosts and curl -L would
  # forward a custom header like PRIVATE-TOKEN there.
  curl -fsSL "$@" "$url" -o "$tmp/pkg.zip" || { echo "download failed: $url" >&2; exit 1; }
  echo "$tmp/pkg.zip"
}

# Hub base for `install <id>` from settings $1 = hub_base, $2 = hub_repo:
# hub_base as given (trailing `/` dropped); empty / unsubstituted `{{…}}` →
# the GitHub raw `extensions/` dir on `main` of a GitHub hub_repo (the
# server's updates/update-json.ts defaultHubBase); nothing for any other hub.
hub_base() {
  local b=${1:-} h
  if [[ -n $b && $b != '{{'* ]]; then echo "${b%/}"; return; fi
  h=$(hub_url "${2:-}")
  if [[ $h =~ ^https://github\.com/([A-Za-z0-9][A-Za-z0-9_.-]*)/([A-Za-z0-9_.-]+)$ ]]; then
    echo "https://raw.githubusercontent.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}/main/extensions"
  fi
}

# update.json `minHalo` $3 for <id> $1 <version> $2 vs the installed Halo
# (`halo --version`, the build sha / `-dirty` dropped — the admin check's rule,
# server updates/update-json.ts haloBaseVersion). Below it → refuse; no
# readable version (no halo command, desktop, dev build) → warn and go on.
hub_check_min_halo() {
  local hv
  hv=$("${HALO_CLI:-halo}" --version 2>/dev/null) || hv=""
  node -e '
    const [id, ver, min, raw] = process.argv.slice(1)
    const base = raw.trim().replace(/^halo\s+/, "").replace(/-dirty$/, "").replace(/-[0-9a-f]{7,40}$/, "")
    const parse = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
      return m && { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split(".") : [] }
    }
    // semver precedence: core numbers, then a prerelease sorts before none.
    const cmp = (a, b) => {
      for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
      if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
      for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i]
        if (x === undefined) return -1
        if (y === undefined) return 1
        if (x === y) continue
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
        if (nx && ny) return Number(x) - Number(y)
        if (nx !== ny) return nx ? -1 : 1
        return x < y ? -1 : 1
      }
      return 0
    }
    const cur = parse(base)
    if (!cur) {
      console.error("warning: cannot read the Halo version (" + (raw.trim() || "no halo command") + ") — not checking that " + id + " " + ver + " needs Halo " + min)
      process.exit(0)
    }
    if (cmp(cur, parse(min)) < 0) {
      console.error(id + " " + ver + " needs Halo " + min + " (this is " + base + ") — upgrade Halo first: halo upgrade && halo server restart")
      process.exit(1)
    }
  ' "$1" "$2" "$3" "$hv"
}

# Fetch hub package <id> into $3 by `<hub base $1>/<id>/update.json`: https
# only (redirects too, ≤ 5), update.json ≤ 64 KB / 10 s, zip ≤ 100 MB (10 min,
# aborted after 30 s under 1 KB/s); a relative `url` resolves against
# update.json's final (redirected) URL; `minHalo` is checked against this
# Halo; the zip must hash to its `sha256`. Echo the zip path; the version it
# promises goes to $3/want-version for the manifest check after unpacking.
hub_fetch_update() {
  local base=$1 id=$2 tmp=$3 json final line url sha ver min got
  local https=(--proto =https --proto-redir =https --max-redirs 5)
  [[ -n $base ]] || { echo "no hub_base set and hub_repo is not a GitHub repo to derive one from — set hub_base (Settings → Skills → extension), or install <path/to.zip>" >&2; exit 1; }
  [[ $base == https://* ]] || { echo "hub_base must be an https URL: $base" >&2; exit 1; }
  json="$base/$id/update.json"
  final=$(curl -fsSL "${https[@]}" --max-time 10 --max-filesize 65536 -o "$tmp/update.json" -w '%{url_effective}' "$json") \
    || { echo "no update.json for $id at $json — check the id and hub_base, or install <path/to.zip>" >&2; exit 1; }
  line=$(node -e '
    const fs = require("fs"), [file, base, id] = process.argv.slice(1)
    const fail = (msg) => { console.log(msg); process.exit(1) }
    let u
    try { u = JSON.parse(fs.readFileSync(file, "utf8")) } catch { fail("not valid JSON") }
    if (!u || typeof u !== "object" || Array.isArray(u)) fail("not a JSON object")
    if (u.id !== id) fail("id " + JSON.stringify(u.id) + " does not match \"" + id + "\"")
    if (typeof u.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(u.version)) fail("version must be semver (x.y.z[-pre])")
    if (typeof u.url !== "string" || u.url === "") fail("url is required")
    let url
    try { url = new URL(u.url, base) } catch { fail("url is invalid: " + u.url) }
    if (url.protocol !== "https:") fail("url must be https: " + url.href)
    if (typeof u.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(u.sha256)) fail("sha256 must be 64 hex characters")
    if (u.minHalo !== undefined && (typeof u.minHalo !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(u.minHalo))) fail("minHalo must be semver (x.y.z[-pre])")
    console.log(url.href + " " + u.sha256.toLowerCase() + " " + u.version + " " + (u.minHalo || ""))
  ' "$tmp/update.json" "$final" "$id") || { echo "invalid update.json at $final: $line" >&2; exit 1; }
  read -r url sha ver min <<<"$line"
  if [[ -n $min ]]; then hub_check_min_halo "$id" "$ver" "$min" || exit 1; fi
  curl -fsSL "${https[@]}" --max-filesize 104857600 --connect-timeout 10 --max-time 600 --speed-limit 1024 --speed-time 30 "$url" -o "$tmp/pkg.zip" \
    || { echo "download failed: $url" >&2; exit 1; }
  got=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/pkg.zip")
  [[ $got == "$sha" ]] || { echo "sha256 mismatch for $url: update.json says $sha, the download is $got" >&2; exit 1; }
  echo "$ver" >"$tmp/want-version"
  echo "$tmp/pkg.zip"
}

# Unpack zip $1 into the new dir $2 with the same refusals as the server's zip
# installer: no `..`, no absolute paths, no symlinks (zipinfo mode column
# starts with `l`).
safe_unzip() {
  if unzip -Z1 "$1" | grep -Eq '(^|/)\.\.(/|$)|^/'; then echo "zip contains ../ or absolute entries" >&2; exit 1; fi
  if unzip -Z "$1" | grep -q '^l'; then echo "zip contains symlinks" >&2; exit 1; fi
  mkdir -p "$2"
  unzip -q "$1" -d "$2"
}

# Drop extension $1's on / off state from `$ROOT/.state.json` (the server's
# extensions/state.ts owns that file; this is its forgetExtension), so the id
# starts on. Missing or unreadable file = nothing to drop. A failed write only
# warns: the directory change it follows already happened.
state_forget() {
  node -e '
    const fs = require("fs"), file = process.argv[1], id = process.argv[2]
    let s
    try { s = JSON.parse(fs.readFileSync(file, "utf8")) } catch { process.exit(0) }
    if (!s || typeof s !== "object" || Array.isArray(s) || !Object.hasOwn(s, id)) process.exit(0)
    delete s[id]
    const tmp = file + "." + process.pid + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n")
    fs.renameSync(tmp, file)
  ' "$ROOT/.state.json" "$1" || echo "warning: could not clear the on / off state of $1 in $ROOT/.state.json" >&2
}

# Model provider configs: newest `models-v*` release of hub $1, https +
# release API only (a provider yaml carries endpoints the server will call —
# no plain-git / local / http source). Validation, planning and the write into
# ~/.halo/global/models.d/ belong to `halo models install` ($HALO_CLI in dev);
# its exit code (3 = endpoint changes need --yes) passes through.
models_update() {
  local hub=$1 platform zip; shift
  if [[ $hub != https://* ]]; then
    echo "model configs need an https release hub (GitHub / Gitea / Forgejo / GitLab) — $hub is not one" >&2; exit 1
  fi
  platform=$(hub_platform "$hub")
  if [[ $platform == git ]]; then
    echo "model configs need a release-API hub (GitHub / Gitea / Forgejo / GitLab) — $hub has no release API" >&2; exit 1
  fi
  zip=$(hub_fetch_release "$platform" "$hub" models "$TMP" --proto =https --proto-redir =https)
  safe_unzip "$zip" "$TMP/models"
  local dir="$TMP/models" only
  # A zip wrapping everything in one directory — descend into it.
  if ! compgen -G "$dir/*.yaml" >/dev/null; then
    only=$(find "$dir" -mindepth 1 -maxdepth 1 | head -2)
    if [[ $(printf '%s\n' "$only" | wc -l) -eq 1 && -d $only ]]; then dir=$only; fi
  fi
  # Last command: under `set -e` its non-zero status (3 = confirm) is the script's.
  "${HALO_CLI:-halo}" models install "$dir" "$@"
}

# Echo a local zip path for source $1 (path, https URL, or hub id).
resolve_source() {
  local src=$1
  if [[ -f $src ]]; then echo "$src"; return; fi
  if [[ $src =~ ^https?:// ]]; then curl -fsSL "$src" -o "$TMP/pkg.zip"; echo "$TMP/pkg.zip"; return; fi
  [[ $src =~ $ID_RE ]] || { echo "invalid id or missing file: $src" >&2; exit 1; }
  hub_fetch_update "$(hub_base "${HALO_HUB_BASE:-}" "${HALO_HUB_REPO:-}")" "$src" "$TMP"
}

# Sourced (tests, later reuse of the hub_* functions): definitions only.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then return 0; fi

cmd=${1:?usage: ext.sh install <id|zip|url> | list | remove <id>}
shift || true

case $cmd in
  install)
    src=${1:?usage: ext.sh install <id|zip|url>}
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    pkg=$(resolve_source "$src")
    safe_unzip "$pkg" "$TMP/x"
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
    if [[ -f $TMP/want-version ]]; then
      want=$(<"$TMP/want-version")
      [[ $ver == "$want" ]] || { echo "invalid extension: manifest version \"$ver\" does not match update.json \"$want\"" >&2; exit 1; }
    fi
    mkdir -p "$ROOT"
    stage="$ROOT/.tmp-$id-$RANDOM$RANDOM"
    mv "$dir" "$stage"
    old=""
    # A fresh install (no `<id>/` yet) starts on, whatever a manual `rm -rf`
    # left in the state file; an update keeps the switch.
    if [[ -d $ROOT/$id ]]; then old="$ROOT/.old-$id-$RANDOM$RANDOM"; mv "$ROOT/$id" "$old"; else state_forget "$id"; fi
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
    state_forget "$id"
    echo "removed $id" ;;
  models)
    sub=${1:-update}
    shift || true
    case $sub in
      list) exec "${HALO_CLI:-halo}" models list ;;
      update)
        for a in "$@"; do [[ $a == --yes ]] || { echo "usage: ext.sh models update [--yes] | models list" >&2; exit 1; }; done
        TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
        models_update "$(hub_url "${HALO_HUB_REPO:-}")" "$@" ;;
      *) echo "usage: ext.sh models update [--yes] | models list" >&2; exit 1 ;;
    esac ;;
  *)
    echo "unknown command: $cmd (install | list | remove | models)" >&2; exit 1 ;;
esac
