#!/usr/bin/env bash
# PostgreSQL backup of the running stack (OPS-002).
#
#   scripts/ops/backup-db.sh [--label TEXT] [--out DIR]
#
# Writes, into DIR (default $TAKTIC_BACKUP_DIR or ~/Backups/taktic, mode 0700):
#
#   taktic-db-<UTC>-<label>.dump            pg_dump custom format
#   taktic-db-<UTC>-<label>.dump.sha256     "<hex>  <file>" (shasum -c format)
#   taktic-db-<UTC>-<label>.dump.manifest   key=value facts about the dump
#
# The dump is taken by the server's own pg_dump inside the postgres container
# (same major version by construction) over its local socket; no password
# leaves the container. It is written to a .partial file and renamed only
# after it has been proven readable: `pg_restore --list` must parse it and
# must list the data of _prisma_migrations. Any failure leaves no file that
# looks like a finished backup.
#
# Nothing is ever deleted. There is no retention behaviour in this script at
# all: removing an old backup is an operator's explicit decision.
#
# The last line on stdout is `BACKUP_FILE=<absolute path>` for callers.
# Works against the development stack too (same container names).

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

label="manual"
out_dir="$BACKUP_ROOT/db"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --label) label="${2:?--label needs a value}"; shift 2 ;;
    --out) out_dir="${2:?--out needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$label" in
  *[!A-Za-z0-9._-]* | "") die "--label may contain only letters, digits, '.', '_' and '-'" ;;
esac

require_cmd docker awk
require_postgres_ready

db="$(pg_container_db)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
base="taktic-db-${stamp}-${label}.dump"
final="$out_dir/$base"
partial="$final.partial"
[ ! -e "$final" ] || die "refusing to overwrite $final"

cleanup() { rm -f "$partial" "$partial.toc"; }
trap cleanup EXIT

step "Dumping database '$db' from $POSTGRES_CONTAINER"
migrations="$(applied_migration_count)"
last_migration="$(pg_query 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1')"
server_version="$(pg_query 'SHOW server_version')"
db_size="$(pg_query "SELECT pg_database_size(current_database())")"
tables="$(pg_query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
# Exact row counts, for the restore rehearsal to compare against. Read just
# before the dump; on a stack whose API is stopped (the deploy path) they are
# the dump's own counts.
row_counts="$(pg_query "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")"

docker exec "$POSTGRES_CONTAINER" pg_dump \
  --format=custom --compress=6 --no-owner --no-privileges \
  -U "$(pg_container_user)" -d "$db" >"$partial"

size="$(file_size "$partial")"
[ "$size" -gt 0 ] || die "pg_dump produced an empty file"

step "Verifying the dump is readable (pg_restore --list)"
docker exec -i "$POSTGRES_CONTAINER" pg_restore --list <"$partial" >"$partial.toc" \
  || die "pg_restore could not read the dump"
toc_entries="$(grep -cv '^;' "$partial.toc" || true)"
table_data="$(grep -c ' TABLE DATA ' "$partial.toc" || true)"
grep -q 'TABLE DATA public _prisma_migrations ' "$partial.toc" \
  || die "dump does not contain the data of _prisma_migrations"
[ "$table_data" -gt 0 ] || die "dump lists no TABLE DATA entries"

sha="$(sha256_of "$partial")"
mv "$partial" "$final"
rm -f "$partial.toc"
printf '%s  %s\n' "$sha" "$base" >"$final.sha256"

git_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
{
  echo "kind=postgres-custom-dump"
  echo "file=$base"
  echo "created_at=$(_ts)"
  echo "container=$POSTGRES_CONTAINER"
  echo "compose_project=$(container_label "$POSTGRES_CONTAINER" com.docker.compose.project)"
  echo "database=$db"
  echo "server_version=$server_version"
  echo "database_size_bytes=$db_size"
  echo "size_bytes=$size"
  echo "sha256=$sha"
  echo "toc_entries=$toc_entries"
  echo "table_data_entries=$table_data"
  echo "public_tables=$tables"
  echo "migrations_applied=$migrations"
  echo "last_migration=$last_migration"
  echo "repo_head=$git_head"
  printf '%s\n' "$row_counts" | sed 's/^/rows./'
} >"$final.manifest"
chmod 600 "$final" "$final.sha256" "$final.manifest"
trap - EXIT

log "dump:      $final"
log "size:      $size bytes   sha256: $sha"
log "contents:  $toc_entries TOC entries, $table_data TABLE DATA, $tables tables, $migrations migrations (last: $last_migration)"
echo "BACKUP_FILE=$final"
