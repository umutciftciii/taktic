#!/usr/bin/env bash
# Upload volume backup (OPS-002, OPS-003).
#
#   scripts/ops/backup-uploads.sh [--label TEXT] [--out DIR]
#                                 [--volume NAME] [--allow-empty]
#
# Which volume: the one the API container actually mounts at
# /app/apps/api/uploads — read from `docker inspect`, not guessed from a
# project name. That is the failure OPS-003 is about: a host can carry more
# than one `*_taktic-api-uploads` volume (one per compose project name it has
# ever been started under), and exporting the wrong one produces a perfectly
# valid, empty archive. Only when the API container does not exist is
# --volume (or COMPOSE_PROJECT_NAME, as <project>_taktic-api-uploads) used,
# and the script says which rule chose the volume.
#
# Refuses to archive anything dangerous to restore: a symbolic link, a hard
# link, a device, a FIFO or a socket anywhere in the volume stops the backup.
# Entries are stored relative (./category-images/...), and the listing of the
# finished archive is checked again: no absolute path, no '..' component, no
# entry type other than file or directory, and the same file count.
#
# An empty volume is an error, not a successful backup: exit 3, no archive.
# --allow-empty writes the (empty) archive anyway, marks it `empty=true` in
# the manifest and warns — for a host that has genuinely never stored an
# upload (see the OPS-003 notes in docs/ops/deploy-runtime.md).
#
# Output next to each other in DIR (default $TAKTIC_BACKUP_DIR/uploads):
#   taktic-uploads-<UTC>-<label>.tar.gz (+ .sha256, .manifest, .files.sha256)
# The last stdout line is `UPLOADS_ARCHIVE=<path>`. Nothing is ever deleted.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

label="manual"
out_dir="$BACKUP_ROOT/uploads"
volume=""
allow_empty=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --label) label="${2:?--label needs a value}"; shift 2 ;;
    --out) out_dir="${2:?--out needs a value}"; shift 2 ;;
    --volume) volume="${2:?--volume needs a value}"; shift 2 ;;
    --allow-empty) allow_empty=1; shift ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$label" in
  *[!A-Za-z0-9._-]* | "") die "--label may contain only letters, digits, '.', '_' and '-'" ;;
esac

require_cmd docker awk

source_rule=""
mounted="$(api_uploads_volume)"
if [ -n "$mounted" ]; then
  if [ -n "$volume" ] && [ "$volume" != "$mounted" ]; then
    die "--volume $volume differs from the volume $API_CONTAINER mounts at $UPLOADS_MOUNT_POINT ($mounted); refusing to guess"
  fi
  volume="$mounted"
  source_rule="mounted by $API_CONTAINER at $UPLOADS_MOUNT_POINT"
elif [ -n "$volume" ]; then
  source_rule="--volume (no $API_CONTAINER container to read the mount from)"
else
  project="$(env_or_file COMPOSE_PROJECT_NAME)"
  [ -n "$project" ] || die "no $API_CONTAINER container, no --volume and no COMPOSE_PROJECT_NAME: cannot tell which volume holds the uploads"
  volume="${project}_taktic-api-uploads"
  source_rule="COMPOSE_PROJECT_NAME ($project); no $API_CONTAINER container"
fi
docker volume inspect "$volume" >/dev/null 2>&1 || die "volume not found: $volume"

step "Uploads volume: $volume ($source_rule)"
others="$(docker volume ls -q | grep -E '_taktic-api-uploads$' | grep -vx "$volume" || true)"
if [ -n "$others" ]; then
  warn "other upload volumes exist on this host and are NOT being backed up: $(echo "$others" | tr '\n' ' ')"
fi

# One pass over the volume: refuse anything that is not a plain file or a
# directory, then count. Prints "files=<n> bytes=<n>".
scan="$(helper_run -v "$volume:/src:ro" "$HELPER_IMAGE" -c '
  set -eu
  cd /src
  bad="$(find . ! -type f ! -type d | head -n 20)"
  if [ -n "$bad" ]; then
    echo "UNSAFE"; echo "$bad"; exit 0
  fi
  hard="$(find . -type f -links +1 | head -n 20)"
  if [ -n "$hard" ]; then
    echo "HARDLINK"; echo "$hard"; exit 0
  fi
  files=$(find . -type f | wc -l | tr -d " ")
  bytes=$(find . -type f -exec cat {} + 2>/dev/null | wc -c | tr -d " ")
  echo "files=$files bytes=$bytes"
')"
case "$scan" in
  UNSAFE*) die "volume contains symlinks or special files; refusing to archive:$(printf '\n%s' "${scan#UNSAFE}")" ;;
  HARDLINK*) die "volume contains hard-linked files; refusing to archive:$(printf '\n%s' "${scan#HARDLINK}")" ;;
esac
files="$(printf '%s' "$scan" | sed -n 's/^files=\([0-9]*\) .*/\1/p')"
bytes="$(printf '%s' "$scan" | sed -n 's/.* bytes=\([0-9]*\)$/\1/p')"
[ -n "$files" ] || die "could not scan the volume: $scan"
log "source: $files files, $bytes bytes"

empty=false
if [ "$files" -eq 0 ]; then
  if [ "$allow_empty" -ne 1 ]; then
    printf '%s  FAIL uploads volume %s holds no files. Not writing an archive that would look like a backup.\n' "$(_ts)" "$volume" >&2
    printf '%s       If this host has really never stored an upload, rerun with --allow-empty.\n' "$(_ts)" >&2
    exit 3
  fi
  empty=true
  warn "volume $volume is EMPTY; writing an empty archive because --allow-empty was given"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
base="taktic-uploads-${stamp}-${label}.tar.gz"
final="$out_dir/$base"
partial="$final.partial"
[ ! -e "$final" ] || die "refusing to overwrite $final"
trap 'rm -f "$partial" "$partial.files" "$partial.list"' EXIT

step "Archiving"
helper_run -v "$volume:/src:ro" "$HELPER_IMAGE" -c 'cd /src && tar -czf - .' >"$partial"
helper_run -v "$volume:/src:ro" "$HELPER_IMAGE" -c 'cd /src && find . -type f -exec sha256sum {} + | sort -k2' >"$partial.files"

step "Verifying the archive listing"
helper_run "$HELPER_IMAGE" -c 'tar -tzvf -' <"$partial" >"$partial.list" || die "tar could not read the archive back"
awk "$ARCHIVE_LISTING_AWK" "$partial.list" || die "archive listing failed the safety check"
listed_files="$(awk 'substr($1,1,1) == "-"' "$partial.list" | wc -l | tr -d ' ')"
[ "$listed_files" -eq "$files" ] || die "archive lists $listed_files files, the volume holds $files"
summed_files="$(wc -l <"$partial.files" | tr -d ' ')"
[ "$summed_files" -eq "$files" ] || die "checksum list has $summed_files entries, the volume holds $files"

sha="$(sha256_of "$partial")"
mv "$partial" "$final"
mv "$partial.files" "$final.files.sha256"
rm -f "$partial.list"
printf '%s  %s\n' "$sha" "$base" >"$final.sha256"
{
  echo "kind=uploads-tar-gz"
  echo "file=$base"
  echo "created_at=$(_ts)"
  echo "volume=$volume"
  echo "volume_rule=$source_rule"
  echo "volume_project=$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$volume" 2>/dev/null || true)"
  echo "files=$files"
  echo "bytes=$bytes"
  echo "empty=$empty"
  echo "size_bytes=$(file_size "$final")"
  echo "sha256=$sha"
} >"$final.manifest"
chmod 600 "$final" "$final.sha256" "$final.manifest" "$final.files.sha256"
trap - EXIT

log "archive:   $final"
log "sha256:    $sha   files: $files   empty: $empty"
echo "UPLOADS_ARCHIVE=$final"
