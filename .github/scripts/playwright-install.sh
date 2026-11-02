#!/usr/bin/env bash
# Installs one Playwright browser and its system packages for a CI job
# (CI-PERF-002A), so that a slow Ubuntu mirror cannot stretch a job by ten
# minutes the way `playwright install --with-deps` let it (one shard spent 608 s
# fetching 21 MB at 35 kB/s).
#
#   playwright-install.sh resolve <browser>   before actions/cache/restore
#   playwright-install.sh install <browser>   after it
#   playwright-install.sh prefetch <browser>  after it, on main: files only
#
# resolve: `apt-get update`, then asks Playwright which system packages the
#   browser still needs (`install-deps --dry-run`, its own list) and asks apt
#   for the exact files: name, size and SHA256 from the signed package index
#   (`--print-uris`). That manifest names the cache key, so a package update,
#   a runner image or a Playwright version each make a new key.
#
# install: keeps only the cached .deb files whose name, size and SHA256 match
#   the manifest — anything else is deleted and reported, never installed —
#   downloads what is left, installs exactly the manifest from local files,
#   downloads the browser, and then asks Playwright again: the job fails unless
#   it reports every system dependency installed.
#
# Each failure is handled by what it is (CI-PERF-002B), and nothing waits
# without a bound:
#
#   apt-get update, dpkg, browser  120 s each, retried once after `recover`;
#                                  a second failure fails the step
#   package download               120 s attempts that resume one another
#                                  (apt keeps what arrived) while each brings
#                                  new bytes, within a 360 s budget. Slow but
#                                  moving is only slower; an attempt that
#                                  brings nothing (a stall), a second apt error
#                                  or a spent budget ends the fast path
#   fast path ended (install)      Playwright's own `install-deps`, the path
#                                  `--with-deps` always took: apt fetches and
#                                  verifies every file against the signed index
#                                  itself. One attempt, 600 s. The files this
#                                  run already verified are handed to it, so it
#                                  only fetches the rest. Never cached
#   a file that does not match     fails the step, with no fallback: a mirror
#   its hash (apt's "Hash Sum      serving other bytes than the signed index
#   mismatch", or the manifest     names, or a manifest that disagrees with
#   after the download)            apt's index, is not slowness, and no retry
#                                  explains it
#
# Between two attempts the killed one is cleaned up: its processes are gone
# (timeout signals the whole process group; `recover` kills any root apt that a
# sudo session kept out of that group), dpkg finishes or rolls back
# whatever it was configuring, and a half-downloaded file is either completed
# or replaced by apt, then checked against the manifest like every other file.
# A cache that is missing, stale or wrong only ever means more is downloaded;
# whichever path installed the packages, the final check decides the step.

set -euo pipefail

mode=${1:?usage: playwright-install.sh resolve|install|prefetch <browser>}
browser=${2:?usage: playwright-install.sh resolve|install|prefetch <browser>}
case "$browser" in chromium | webkit) ;; *) echo "unsupported browser: $browser" >&2; exit 2 ;; esac

# The Playwright CLI the e2e package pins; overridable for the script's tests.
read -r -a PW <<<"${PLAYWRIGHT_CLI:-pnpm --filter @taktic/e2e exec playwright}"
TIMEOUT=${PW_INSTALL_TIMEOUT_SECONDS:-120}
# Only for exercising the retry path: a shorter limit on each first attempt.
FIRST_TIMEOUT=${PW_INSTALL_FIRST_ATTEMPT_TIMEOUT_SECONDS:-$TIMEOUT}
DOWNLOAD_BUDGET=${PW_DOWNLOAD_BUDGET_SECONDS:-360}
FALLBACK_TIMEOUT=${PW_FALLBACK_TIMEOUT_SECONDS:-600}
# Where the fallback's apt looks for archives it already has.
SYSTEM_ARCHIVES=${PW_APT_SYSTEM_ARCHIVES:-/var/cache/apt/archives}
# Outside $HOME: apt downloads as its sandbox user _apt, which cannot enter a
# 0750 home directory and would otherwise fetch unsandboxed as root.
DEB_DIR=${PW_APT_CACHE_DIR:-/var/cache/playwright-apt/$browser}
# apt's download sandbox user; empty only for the script's tests, which run apt
# as a stand-in without root.
SANDBOX_USER=${PW_APT_SANDBOX_USER-_apt}
WORK=${PW_INSTALL_WORK_DIR:-${RUNNER_TEMP:-/tmp}/playwright-install-$browser}
MANIFEST=$WORK/manifest
PACKAGES=$WORK/packages
# Written last by a resolve that finished; install refuses to run without it.
RESOLVED=$WORK/resolved
SUDO=sudo
[ "$(id -u)" = 0 ] && SUDO=

# apt waits for a lock rather than failing on it, and never asks a question.
# `env` carries DEBIAN_FRONTEND through sudo, which resets the environment.
# ForceHash=SHA256: apt verifies every download by SHA256, and --print-uris
# reports that hash (on ubuntu 24.04 it printed MD5Sum without it).
# A connection silent for 30 s is dropped and that file retried by apt itself,
# rather than holding the attempt until its timeout.
APT=(env DEBIAN_FRONTEND=noninteractive apt-get -q -y -o DPkg::Lock::Timeout=60 -o Dpkg::Use-Pty=0
  -o Acquire::ForceHash=SHA256 -o Acquire::http::Timeout=30 -o Acquire::Retries=3)

mkdir -p "$WORK"
# fd 3 is the step log, for what a function whose stdout is captured reports.
exec 3>&1
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY" || true; }
output() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s\n' "$@" >>"$GITHUB_OUTPUT" || true; }
timings=()

# attempt <label> root|user <command…> — up to two attempts, each under a
# timeout; `recover` between them. Returns non-zero only after the second.
attempt() {
  local label=$1 as=$2 n=1 limit=$FIRST_TIMEOUT started status
  shift 2
  while :; do
    started=$SECONDS
    set +e
    if [ "$as" = root ]; then
      $SUDO timeout --kill-after=15 "$limit" "$@"
    else
      timeout --kill-after=15 "$limit" "$@"
    fi
    status=$?
    set -e
    timings+=("$label=$((SECONDS - started))s#$n")
    [ "$status" -eq 0 ] && return 0
    if [ "$n" -ge 2 ]; then
      echo "::error::playwright-install: $label failed on its retry too (exit $status)"
      return 1
    fi
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      echo "::warning::playwright-install: $label timed out after ${limit}s; retrying once"
    else
      echo "::warning::playwright-install: $label exited $status; retrying once"
    fi
    recover
    n=2
    limit=$TIMEOUT
  done
}

# What a killed attempt may leave behind. timeout signals its whole process
# group, so no apt or dpkg process should outlive it; the pkill is a backstop.
# `dpkg --configure -a` completes any package the attempt left unpacked but not
# configured — the state apt refuses to start from.
recover() {
  $SUDO pkill -KILL -x apt-get 2>/dev/null || true
  $SUDO pkill -KILL -x dpkg 2>/dev/null || true
  # Bounded and non-interactive like every other phase: a conffile question
  # or a slow trigger must not hold the retry indefinitely.
  if ! $SUDO timeout --kill-after=15 "$TIMEOUT" env DEBIAN_FRONTEND=noninteractive \
    dpkg --force-confdef --force-confold --configure -a; then
    echo "::warning::playwright-install: dpkg --configure -a did not finish cleanly; the retry decides"
  fi
}

# Missing system packages for the browser, one per line, as Playwright's own
# dry run reports them (it simulates its install with apt-get -s). Exit 0 means
# nothing is missing; 1 with a list means those are; anything else is an error.
missing_packages() {
  local out status
  set +e
  out=$("${PW[@]}" install-deps --dry-run "$browser" 2>&1)
  status=$?
  set -e
  if [ "$status" -eq 0 ] && grep -q 'All system dependencies are installed' <<<"$out"; then
    return 0
  fi
  if [ "$status" -eq 1 ] && grep -q '^Missing system dependencies (' <<<"$out"; then
    # The list must hold exactly as many names as the heading announces: a
    # change in Playwright's wording must fail here, not read as "none".
    local want list got
    want=$(sed -n 's/^Missing system dependencies (\([0-9][0-9]*\)):.*/\1/p' <<<"$out")
    list=$(sed -n 's/^  \([a-z0-9][a-z0-9.+:-]*\)$/\1/p' <<<"$out")
    got=$(grep -c . <<<"$list" || true)
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
      printf '%s\n' "$list"
      return 0
    fi
    printf '%s\n' "$out" >&3
    echo "::error::playwright-install: Playwright announced ${want:-?} missing packages but $got could be read" >&3
    return 1
  fi
  printf '%s\n' "$out" >&3
  echo "::error::playwright-install: could not read Playwright's dependency check (exit $status)" >&3
  return 1
}

do_resolve() {
  rm -f "$RESOLVED"
  # Owned by the runner, so actions/cache/restore can unpack into it.
  $SUDO install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$DEB_DIR"
  attempt "apt-get update" root "${APT[@]}" update

  missing_packages >"$PACKAGES"
  local count
  count=$(wc -l <"$PACKAGES" | tr -d ' ')
  : >"$MANIFEST"
  if [ "$count" -gt 0 ]; then
    # Every file apt would fetch for exactly these packages, from the index
    # `apt-get update` just verified against the archive's signature:
    #   'URI' file_name size SHA256:hex
    local empty uris pkgs
    mapfile -t pkgs <"$PACKAGES"
    empty=$(mktemp -d)
    uris=$($SUDO "${APT[@]}" --no-install-recommends -o Dir::Cache::Archives="$empty" \
      install --print-uris "${pkgs[@]}")
    rmdir "$empty" 2>/dev/null || true
    awk '$1 ~ /^\x27/ && $4 ~ /^SHA256:/ { sub(/^SHA256:/, "", $4); print $2, $3, $4 }' <<<"$uris" | sort >"$MANIFEST"
    if [ ! -s "$MANIFEST" ]; then
      printf '%s\n' "$uris" >&2
      echo "::error::playwright-install: apt listed no files with a SHA256 for $count missing packages"
      return 1
    fi
  fi

  local version image hash
  version=$("${PW[@]}" --version | awk '{print $NF}')
  image="${ImageOS:-local}-${ImageVersion:-local}"
  hash=$( (cat "$PACKAGES"; cat "$MANIFEST") | sha256sum | cut -c1-16)
  echo "playwright-install resolve: browser=$browser playwright=$version image=$image packages=$count files=$(wc -l <"$MANIFEST" | tr -d ' ') ${timings[*]}"
  output "key=playwright-apt-$browser-$image-pw$version-$hash" \
    "restore-prefix=playwright-apt-$browser-" \
    "dir=$DEB_DIR" \
    "packages=$count"
  touch "$RESOLVED"
}

# Keeps a cached file only if the manifest lists it with the same size and
# SHA256; deletes everything else. Counts into `kept` and `discarded`.
kept=0
discarded=0
verify_cache() {
  local f name want got
  mkdir -p "$DEB_DIR"
  $SUDO rm -rf "$DEB_DIR/partial" "$DEB_DIR/lock"
  shopt -s nullglob dotglob
  for f in "$DEB_DIR"/*; do
    name=$(basename "$f")
    want=$(awk -v n="$name" '$1 == n { print $2, $3 }' "$MANIFEST")
    if [ -f "$f" ] && [ -n "$want" ]; then
      got="$(stat -c %s "$f") $(sha256sum "$f" | cut -d' ' -f1)"
      if [ "$got" = "$want" ]; then
        kept=$((kept + 1))
        continue
      fi
      echo "::warning::playwright-install: cached $name does not match the package index; discarded"
    fi
    $SUDO rm -rf "$f"
    discarded=$((discarded + 1))
  done
  shopt -u nullglob dotglob
}

# Exactly the manifest's files, each with its size and SHA256 — what dpkg is
# given. A file apt fetched that the manifest does not list fails it too.
assert_complete() {
  local name size sha bad=0 f
  shopt -s nullglob
  for f in "$DEB_DIR"/*.deb; do
    if ! awk -v n="$(basename "$f")" '$1 == n { found = 1 } END { exit !found }' "$MANIFEST"; then
      echo "::error::playwright-install: $(basename "$f") was downloaded but is not in the manifest"
      bad=1
    fi
  done
  shopt -u nullglob
  while read -r name size sha; do
    if [ ! -f "$DEB_DIR/$name" ] || [ "$(stat -c %s "$DEB_DIR/$name") $(sha256sum "$DEB_DIR/$name" | cut -d' ' -f1)" != "$size $sha" ]; then
      echo "::error::playwright-install: $name is missing or does not match the package index after the download"
      bad=1
    fi
  done <"$MANIFEST"
  return "$bad"
}

# What has arrived in DEB_DIR so far, complete files and apt's partial ones:
# "<bytes> <manifest files present>".
progress() {
  local bytes complete=0 name size sha
  bytes=$($SUDO find "$DEB_DIR" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')
  while read -r name size sha; do
    [ -f "$DEB_DIR/$name" ] && complete=$((complete + 1))
  done <"$MANIFEST"
  echo "$bytes $complete"
}

# apt-get --download-only until it finishes, as described at the top: a
# timed-out attempt that brought new bytes or files is resumed by the next,
# within DOWNLOAD_BUDGET; a stall, a second apt error or the spent budget
# returns 1 with `why` set. Called in a condition, so it checks every status
# itself rather than relying on set -e.
download_debs() {
  local n=0 errors=0 limit status before after deadline=$((SECONDS + DOWNLOAD_BUDGET)) started
  while :; do
    n=$((n + 1))
    limit=$TIMEOUT
    [ "$n" -eq 1 ] && limit=$FIRST_TIMEOUT
    [ $((deadline - SECONDS)) -lt "$limit" ] && limit=$((deadline - SECONDS))
    if [ "$limit" -le 0 ]; then
      why="the download budget of ${DOWNLOAD_BUDGET}s is spent ($(progress | cut -d' ' -f2) of $files files here)"
      return 1
    fi
    before=$(progress)
    started=$SECONDS
    set +e
    $SUDO timeout --kill-after=15 "$limit" "${APT[@]}" "${opts[@]}" install --download-only "${pkgs[@]}" 2>&1 |
      tee "$WORK/download.log"
    status=${PIPESTATUS[0]}
    set -e
    timings+=("download=$((SECONDS - started))s#$n")
    [ "$status" -eq 0 ] && return 0
    if grep -q 'Hash Sum mismatch' "$WORK/download.log"; then
      echo "::error::playwright-install: apt rejected a download whose hash does not match the signed index; not falling back"
      exit 1
    fi
    after=$(progress)
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      if [ "${after% *}" -gt "${before% *}" ] || [ "${after#* }" -gt "${before#* }" ]; then
        echo "::warning::playwright-install: download timed out after ${limit}s with $(( ${after% *} - ${before% *} )) bytes new (${after#* } of $files files); resuming"
        recover
        continue
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then
        why="the download budget of ${DOWNLOAD_BUDGET}s is spent (${after#* } of $files files here)"
      else
        why="the download stalled: attempt $n brought nothing in ${limit}s"
      fi
      return 1
    fi
    errors=$((errors + 1))
    if [ "$errors" -ge 2 ]; then
      why="apt-get failed to download a second time (exit $status)"
      return 1
    fi
    echo "::warning::playwright-install: download exited $status; retrying once"
    recover
  done
}

# The manifest's files in DEB_DIR, verified: what the cache held and matched,
# plus what apt downloaded for the rest. Does not touch dpkg. Returns 1 with
# `why` when the download did not finish (the fallback may take over); exits
# when a file does not match the manifest (nothing may take over).
fetch_debs() {
  [ "$files" -gt 0 ] || { echo "::error::playwright-install: $count packages missing but the manifest is empty"; exit 1; }
  verify_cache
  # The download area apt's sandbox user writes to, as in /var/cache/apt.
  if [ -n "$SANDBOX_USER" ] && id "$SANDBOX_USER" >/dev/null 2>&1; then
    $SUDO install -d -o "$SANDBOX_USER" -g root -m 0700 "$DEB_DIR/partial"
  fi
  download_debs || return 1
  assert_complete || exit 1
}

# Playwright's own install path for the system packages, when the fast path
# could not finish. The files this run verified against the manifest go where
# apt looks first; apt checks them against its index again before use. Nothing
# the manifest does not list, and nothing unverified, is handed over.
fallback() {
  local name size sha seeded=0 started status
  path=fallback
  echo "::warning::playwright-install: $why; falling back to Playwright's install-deps (apt verifies every file against the signed index)"
  $SUDO install -d -m 0755 "$SYSTEM_ARCHIVES"
  while read -r name size sha; do
    if [ -f "$DEB_DIR/$name" ] && [ "$(stat -c %s "$DEB_DIR/$name") $(sha256sum "$DEB_DIR/$name" | cut -d' ' -f1)" = "$size $sha" ]; then
      $SUDO install -m 0644 "$DEB_DIR/$name" "$SYSTEM_ARCHIVES/$name"
      seeded=$((seeded + 1))
    fi
  done <"$MANIFEST"
  echo "playwright-install: handing $seeded of $files verified files to install-deps"
  recover
  started=$SECONDS
  set +e
  # As a user: install-deps elevates its own apt commands with sudo. A root
  # apt that sudo's own session keeps from the timeout is killed by `recover`.
  timeout --kill-after=15 "$FALLBACK_TIMEOUT" "${PW[@]}" install-deps "$browser"
  status=$?
  set -e
  timings+=("fallback=$((SECONDS - started))s#1")
  if [ "$status" -ne 0 ]; then
    recover
    echo "::error::playwright-install: the install-deps fallback failed too (exit $status, limit ${FALLBACK_TIMEOUT}s)"
    exit 1
  fi
}

# Leave the directory as actions/cache/save should store it: the manifest's
# files and nothing else (no partial/, no lock, nothing a killed attempt left),
# readable by the runner.
tidy_debs() {
  local f
  shopt -s nullglob dotglob
  for f in "$DEB_DIR"/*; do
    awk -v n="$(basename "$f")" '$1 == n { found = 1 } END { exit !found }' "$MANIFEST" || $SUDO rm -rf "$f"
  done
  shopt -u nullglob dotglob
  $SUDO chown -R "$(id -u):$(id -g)" "$DEB_DIR"
}

report() {
  local what=$1 total=$((SECONDS - started))
  echo "playwright-install $what: browser=$browser cache=$cache path=$path packages=$count files=$files from-cache=$kept discarded=$discarded downloaded=$((files - kept)) total=${total}s ${timings[*]}"
  summary "### Playwright $what: $browser" "" \
    "| cache | path | packages | files from cache | discarded | phases (seconds#attempt) | total |" \
    "|---|---|---|---|---|---|---|" \
    "| $cache | $path | $count | $kept / $files | $discarded | ${timings[*]} | $total s |"
}

load_resolved() {
  [ -f "$RESOLVED" ] || { echo "::error::playwright-install: run 'resolve $browser' first (or it did not finish)"; return 1; }
  count=$(wc -l <"$PACKAGES" | tr -d ' ')
  files=$(wc -l <"$MANIFEST" | tr -d ' ')
  mapfile -t pkgs <"$PACKAGES"
  opts=(--no-install-recommends -o Dir::Cache::Archives="$DEB_DIR")
}

cache=${PW_CACHE_RESULT:-none}
started=$SECONDS
# fast: the verified files, installed by this script; fallback: install-deps;
# none: nothing was missing.
path=none
why=

do_install() {
  load_resolved
  # Only a complete, verified fast path leaves DEB_DIR fit to be cached.
  local cacheable=false
  if [ "$count" -gt 0 ]; then
    if fetch_debs; then
      path=fast
      attempt "install" root "${APT[@]}" "${opts[@]}" install "${pkgs[@]}"
      tidy_debs
      cacheable=true
    else
      fallback
    fi
  fi
  output "cacheable=$cacheable" "path=$path"

  attempt "browser" user "${PW[@]}" install "$browser"

  local still
  still=$(missing_packages)
  if [ -n "$still" ]; then
    echo "::error::playwright-install: Playwright still reports missing system dependencies for $browser:"
    printf '  %s\n' $still
    return 1
  fi
  report install
}

# For the job that keeps main's cache warm: the verified files only — nothing
# is installed and no browser is downloaded. No fallback: an incomplete
# download fails, and nothing is saved.
do_prefetch() {
  load_resolved
  if [ "$count" -gt 0 ]; then
    if ! fetch_debs; then
      echo "::error::playwright-install: $why; nothing to cache"
      exit 1
    fi
    path=fast
    tidy_debs
  fi
  report prefetch
}

case "$mode" in
  resolve) do_resolve ;;
  install) do_install ;;
  prefetch) do_prefetch ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
