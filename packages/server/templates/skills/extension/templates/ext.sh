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
# `install <id>` reads the hub in $HALO_HUB_REPO (the skill's hub_repo param;
# empty → https://github.com/turmind/halo-hub). GitHub / Gitea-Forgejo / GitLab
# hubs go through their public release API (GITHUB_TOKEN / GITEA_TOKEN /
# GITLAB_TOKEN, if set, are sent — lifts GitHub's 60 req/h anonymous limit);
# any other git URL or local repo installs from `<id>-v<semver>` tags.
# Needs curl + unzip + node (+ git for tag-based hubs). No `gh`.
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
# A `.git` suffix stays (git mode clones the URL as given); the API helpers
# below drop it.
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

# github | gitlab | gitea | git (= tag-based fallback) for a normalized hub URL.
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

# stdin = `git ls-remote --tags --refs`; print the highest `<id>-vX.Y.Z` tag
# (prerelease `-…` suffixes skipped), nothing if there is none.
hub_pick_tag() {
  local v
  v=$(sed -n "s|.*refs/tags/$1-v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  if [[ -n $v ]]; then echo "$1-v$v"; fi
}

# Tag-based hub: shallow-clone the newest `<id>-v<semver>` tag and echo
# `extensions/<id>/` minus the build inputs scripts/pack.mjs leaves out of a
# release zip. A package with a build step is refused — its output isn't in git.
hub_git_package() {
  local hub=$1 id=$2 tmp=$3 url=$1 refs tag dir
  if [[ $url == /* ]]; then url="file://$url"; fi   # a plain path makes git ignore --depth
  refs=$(git ls-remote --tags --refs "$url") || { echo "cannot list tags of $hub (git ls-remote failed)" >&2; exit 1; }
  tag=$(printf '%s\n' "$refs" | hub_pick_tag "$id")
  [[ -n $tag ]] || { echo "no release for $id in $hub (no $id-v<x.y.z> tag)" >&2; exit 1; }
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$url" "$tmp/repo" || { echo "git clone of $tag from $hub failed" >&2; exit 1; }
  dir="$tmp/repo/extensions/$id"
  [[ -d $dir ]] || { echo "$hub tag $tag has no extensions/$id/" >&2; exit 1; }
  if [[ -e $dir/fetch-deps.sh || -e $dir/build.sh ]]; then
    echo "$id needs a build step — install it from a release zip (install <path/to.zip> or <https://…zip>)" >&2; exit 1
  fi
  rm -rf "$dir/node_modules" "$dir/src" "$dir/package.json" "$dir/package-lock.json"
  echo "$dir"
}

# Fetch hub package <id> from hub URL $1 into $3: echo a zip path (release
# API) or the package dir (git tags). API errors never fall back to git — a
# git checkout of a build-step package would install broken.
hub_fetch() {
  local hub=$1 id=$2 tmp=$3 platform api url token page
  platform=$(hub_platform "$hub")
  if [[ $platform == git ]]; then hub_git_package "$hub" "$id" "$tmp"; return; fi
  api=$(hub_releases_api "$platform" "$hub")
  page=$(hub_releases_page "$platform" "$hub")
  case $platform in github) token=GITHUB_TOKEN ;; gitlab) token=GITLAB_TOKEN ;; *) token=GITEA_TOKEN ;; esac
  hub_curl "$platform" "$api" -o "$tmp/releases.json" \
    || { echo "$platform release API failed for $hub — rate-limited, private or wrong repo? set $token, or download the zip from $page and run: install <path>" >&2; exit 1; }
  url=$(hub_pick_release "$platform" "$id" <"$tmp/releases.json") \
    || { echo "no release for $id in $hub — check the id, or download the zip from $page and run: install <path>" >&2; exit 1; }
  # No token here: asset links redirect to other hosts and curl -L would
  # forward a custom header like PRIVATE-TOKEN there.
  curl -fsSL "$url" -o "$tmp/pkg.zip" || { echo "download failed: $url" >&2; exit 1; }
  echo "$tmp/pkg.zip"
}

# Echo a local zip or an unpacked package dir for source $1 (path, https URL, or hub id).
resolve_source() {
  local src=$1
  if [[ -f $src ]]; then echo "$src"; return; fi
  if [[ $src =~ ^https?:// ]]; then curl -fsSL "$src" -o "$TMP/pkg.zip"; echo "$TMP/pkg.zip"; return; fi
  [[ $src =~ $ID_RE ]] || { echo "invalid id or missing file: $src" >&2; exit 1; }
  hub_fetch "$(hub_url "${HALO_HUB_REPO:-}")" "$src" "$TMP"
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
    if [[ -d $pkg ]]; then
      dir=$pkg
    else
      # Same refusals as the server's zip installer: no `..`, no absolute paths,
      # no symlinks (zipinfo mode column starts with `l`).
      if unzip -Z1 "$pkg" | grep -Eq '(^|/)\.\.(/|$)|^/'; then echo "zip contains ../ or absolute entries" >&2; exit 1; fi
      if unzip -Z "$pkg" | grep -q '^l'; then echo "zip contains symlinks" >&2; exit 1; fi
      mkdir -p "$TMP/x"
      unzip -q "$pkg" -d "$TMP/x"
      # `zip -r glb.zip glb/` wraps everything in one directory — descend into it.
      dir="$TMP/x"
      if [[ ! -f $dir/halo-extension.json ]]; then
        only=$(find "$dir" -mindepth 1 -maxdepth 1 | head -2)
        if [[ $(printf '%s\n' "$only" | wc -l) -eq 1 && -f $only/halo-extension.json ]]; then dir=$only; fi
      fi
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
