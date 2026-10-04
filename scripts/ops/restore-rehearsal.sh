#!/usr/bin/env bash
# Restore rehearsal: proves a backup can actually be restored (OPS-002).
#
#   scripts/ops/restore-rehearsal.sh --db-dump FILE
#                                    [--uploads-archive FILE]
#                                    [--migrate-image IMAGE]
#
# Never touches a live database. The dump is restored into a brand-new,
# throwaway PostgreSQL container created by this script:
#
#   * its own internal Docker network (no route out, no published port),
#   * its data directory on a tmpfs,
#   * a random password that is never printed,
#   * a database named taktic_restore_rehearsal,
#
# and the container and network are removed on exit, success or failure. The
# live stack's containers, networks and volumes are not referenced at all.
#
# Checks, in order (any failure stops the rehearsal with a non-zero exit):
#   1. the .sha256 sidecar of each file matches the file
#   2. pg_restore --exit-on-error restores the whole dump
#   3. _prisma_migrations has as many applied rows as the manifest recorded,
#      and the same last migration
#   4. every table the manifest lists exists; row counts are compared and
#      differences are reported (an exact match is expected for a dump taken
#      with the API stopped, as the deploy script does)
#   5. with --migrate-image: `migrate status` and the read-only drift check
#      run against the rehearsal database — the restored schema is what that
#      commit expects
#   6. with --uploads-archive: listing safety (no absolute path, no '..', only
#      files and directories), extraction into a tmpfs, and every file's
#      sha256 against the .files.sha256 list taken at backup time

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

dump=""
archive=""
migrate_image=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db-dump) dump="${2:?--db-dump needs a file}"; shift 2 ;;
    --uploads-archive) archive="${2:?--uploads-archive needs a file}"; shift 2 ;;
    --migrate-image) migrate_image="${2:?--migrate-image needs an image}"; shift 2 ;;
    -h | --help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$dump" ] || [ -n "$archive" ] || die "nothing to rehearse: pass --db-dump and/or --uploads-archive"
require_cmd docker awk

verify_sidecar() {
  local file="$1" expected actual
  [ -f "$file" ] || die "not a file: $file"
  [ -f "$file.sha256" ] || die "missing checksum sidecar: $file.sha256"
  expected="$(awk '{print $1}' "$file.sha256")"
  actual="$(sha256_of "$file")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $file (sidecar $expected, file $actual)"
  log "sha256 OK  $(basename "$file")  $actual"
}

manifest_value() {
  sed -n "s/^$2=//p" "$1.manifest" 2>/dev/null | head -n 1
}

suffix="$(date -u +%Y%m%d%H%M%S)-$$"
network="taktic-restore-rehearsal-$suffix"
pg="taktic-restore-rehearsal-$suffix"
rdb="taktic_restore_rehearsal"
created_network=0
created_pg=0

teardown() {
  local code=$?
  if [ "$created_pg" = 1 ]; then docker rm -f "$pg" >/dev/null 2>&1 || true; fi
  if [ "$created_network" = 1 ]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  if [ "$code" -eq 0 ]; then log "rehearsal environment removed"; else warn "rehearsal failed (exit $code); environment removed"; fi
}
trap teardown EXIT

if [ -n "$dump" ]; then
  step "1. Checksum: database dump"
  verify_sidecar "$dump"

  step "2. Restoring into an isolated, throwaway PostgreSQL"
  server_image="${TAKTIC_REHEARSAL_PG_IMAGE:-$HELPER_IMAGE}"
  docker network create --internal "$network" >/dev/null
  created_network=1
  password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  docker run -d --name "$pg" --network "$network" --network-alias rehearsal-postgres \
    --tmpfs /var/lib/postgresql/data:rw,size=2g \
    --label taktic.purpose=restore-rehearsal \
    -e POSTGRES_DB="$rdb" -e POSTGRES_USER=rehearsal -e POSTGRES_PASSWORD="$password" \
    "$server_image" >/dev/null
  created_pg=1
  waited=0
  until docker exec "$pg" pg_isready -q -U rehearsal -d "$rdb" 2>/dev/null; do
    [ "$waited" -lt 60 ] || die "rehearsal PostgreSQL did not start"
    sleep 1
    waited=$((waited + 1))
  done
  # The init script restarts the server once; wait for the final one.
  sleep 2
  until docker exec "$pg" pg_isready -q -U rehearsal -d "$rdb" 2>/dev/null; do sleep 1; done
  log "rehearsal server: $(docker exec "$pg" psql -X -tA -U rehearsal -d "$rdb" -c 'SHOW server_version'), database $rdb, network $network (internal)"

  docker exec -i "$pg" pg_restore --exit-on-error --no-owner --no-privileges \
    -U rehearsal -d "$rdb" <"$dump" || die "pg_restore failed"
  log "pg_restore completed without error"

  rq() { docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -X -q -tA -U rehearsal -d "$rdb" -c "$1"; }

  step "3. Migration history"
  restored_migrations="$(rq 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
  restored_last="$(rq 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1')"
  expected_migrations="$(manifest_value "$dump" migrations_applied)"
  expected_last="$(manifest_value "$dump" last_migration)"
  log "restored: $restored_migrations applied migrations, last $restored_last"
  if [ -n "$expected_migrations" ]; then
    [ "$restored_migrations" = "$expected_migrations" ] || die "manifest recorded $expected_migrations applied migrations, the restore has $restored_migrations"
    [ "$restored_last" = "$expected_last" ] || die "manifest recorded last migration $expected_last, the restore has $restored_last"
    log "matches the manifest"
  else
    warn "no manifest next to the dump; migration count not compared"
  fi

  step "4. Tables and row counts"
  restored_counts="$(rq "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")"
  restored_tables="$(printf '%s\n' "$restored_counts" | grep -c . || true)"
  total_rows="$(printf '%s\n' "$restored_counts" | awk -F= '{s += $2} END {print s + 0}')"
  log "restored: $restored_tables tables, $total_rows rows"
  if [ -f "$dump.manifest" ]; then
    missing=0
    differing=0
    while IFS='=' read -r key value; do
      table="${key#rows.}"
      got="$(printf '%s\n' "$restored_counts" | sed -n "s/^${table}=//p")"
      if [ -z "$got" ]; then
        printf '%s  FAIL table missing after restore: %s\n' "$(_ts)" "$table" >&2
        missing=$((missing + 1))
      elif [ "$got" != "$value" ]; then
        warn "row count differs for $table: manifest $value, restored $got"
        differing=$((differing + 1))
      fi
    done <<EOF
$(grep '^rows\.' "$dump.manifest")
EOF
    [ "$missing" -eq 0 ] || die "$missing table(s) from the manifest are missing"
    if [ "$differing" -eq 0 ]; then
      log "every table and row count matches the manifest"
    else
      warn "$differing table(s) differ in row count (expected only for a dump taken while the API was writing)"
    fi
  fi

  if [ -n "$migrate_image" ]; then
    step "5. Prisma view of the restored database ($migrate_image)"
    rehearsal_url="postgresql://rehearsal:${password}@rehearsal-postgres:5432/${rdb}?schema=public"
    set +e
    status_out="$(docker run --rm --network "$network" -e DATABASE_URL="$rehearsal_url" "$migrate_image" status 2>&1)"
    status_code=$?
    drift_out="$(docker run --rm --network "$network" -e DATABASE_URL="$rehearsal_url" "$migrate_image" drift 2>&1)"
    drift_code=$?
    set -e
    printf '%s\n' "$status_out" | sed "s#${password}#***#g" | grep -vE '^\s*$' | sed 's/^/    status | /' >&2
    printf '%s\n' "$drift_out" | sed "s#${password}#***#g" | grep -vE '^\s*$' | head -n 40 | sed 's/^/    drift  | /' >&2
    case "$status_code:$status_out" in
      0:*"Database schema is up to date"*) log "migrate status: up to date for this image" ;;
      1:*"have not yet been applied"*) warn "migrate status: the image carries migrations the backup does not have (a pre-deploy backup of an older release)" ;;
      *) die "migrate status failed (exit $status_code)" ;;
    esac
    case "$drift_code" in
      0) log "drift check: restored schema matches the image's schema.prisma" ;;
      2) if [ "$status_code" = 1 ]; then warn "drift reported, consistent with the pending migrations above"; else die "drift: restored schema differs from the image's schema.prisma"; fi ;;
      *) die "drift check failed (exit $drift_code)" ;;
    esac
  fi
fi

if [ -n "$archive" ]; then
  step "6. Uploads archive"
  verify_sidecar "$archive"
  [ -f "$archive.files.sha256" ] || die "missing per-file checksum list: $archive.files.sha256"
  expected_files="$(wc -l <"$archive.files.sha256" | tr -d ' ')"
  # Listing safety, extraction into a tmpfs, per-file checksums — all inside
  # one throwaway container with no network, reading the archive from stdin;
  # the backup-time checksum list is mounted read-only.
  list_dir="$(cd "$(dirname "$archive")" && pwd)"
  list_name="$(basename "$archive").files.sha256"
  result="$(helper_run -e "LISTING_AWK=$ARCHIVE_LISTING_AWK" --tmpfs /restore:rw,size=2g -v "$list_dir/$list_name:/expected.sha256:ro" "$HELPER_IMAGE" -c '
    set -eu
    cat > /restore/archive.tar.gz
    tar -tzvf /restore/archive.tar.gz > /restore/list
    if ! awk "$LISTING_AWK" /restore/list; then
      echo "LISTING_UNSAFE"; exit 0
    fi
    mkdir /restore/tree
    tar -xzf /restore/archive.tar.gz -C /restore/tree -o
    cd /restore/tree
    files=$(find . -type f | wc -l | tr -d " ")
    if [ "$files" -eq 0 ]; then echo "files=0 checksums=empty"; exit 0; fi
    if sha256sum -c -s /expected.sha256; then echo "files=$files checksums=ok"; else echo "files=$files checksums=MISMATCH"; fi
  ' <"$archive")" || die "uploads archive could not be read back (corrupt or truncated)"
  case "$result" in
    *LISTING_UNSAFE*) die "archive listing failed the safety check: ${result%LISTING_UNSAFE*}" ;;
    *checksums=MISMATCH*) die "extracted files do not match the backup-time checksums ($result)" ;;
    *checksums=ok* | *checksums=empty*) ;;
    *) die "archive check did not complete: $result" ;;
  esac
  got_files="$(printf '%s' "$result" | sed -n 's/.*files=\([0-9]*\).*/\1/p')"
  [ "$got_files" = "$expected_files" ] || die "archive extracted $got_files files, the backup recorded $expected_files"
  if [ "$got_files" = 0 ]; then
    warn "uploads archive is empty (manifest empty=$(manifest_value "$archive" empty))"
  else
    log "uploads archive: $got_files files extracted, every sha256 matches"
  fi
fi

step "Restore rehearsal passed"
