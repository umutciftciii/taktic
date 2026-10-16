#!/usr/bin/env bash
# P3009 recovery on staging: prove that a failed migration left nothing
# behind, and only then mark it rolled back (STAGING-P3009-HARDENING-001).
#
#   scripts/ops/migration-recover.sh --sha <commit>
#       read-only report. Writes nothing, changes nothing. Says whether the
#       failed migration can be marked rolled back, and if so prints the exact
#       confirmation to pass back. Exit 0: nothing to resolve, or resolvable;
#       1: not resolvable — restore or fix forward (docs/ops/deploy-runtime.md,
#       "P3009").
#
#   scripts/ops/migration-recover.sh --sha <commit> --migration <name> \
#       --database-id <id> --confirm "rolled-back <name> on <id>"
#       re-runs every check, then `migrate resolve --rolled-back <name>`
#       through the migrate image's guard, then proves the row is rolled back.
#       Each attempt is appended to $TAKTIC_BACKUP_DIR/ops-audit/migration-recover.jsonl.
#
#   [--project <name>]   the compose project PostgreSQL must belong to
#                        (default taktic-staging)
#   [--environment staging]  the only accepted value; production is refused
#
# <commit> is the commit whose deploy failed: its migrate image carries the
# migration file and the guard. Nothing here runs automatically, and nothing
# here bypasses the guard: the guard itself refuses resolve-rolled-back
# outside APP_ENVIRONMENT=staging and without the confirmation, and Prisma
# refuses a migration that is not in a failed state (P3012).
#
# What "left nothing behind" means — every point must hold, or the answer is no:
#   1  staging: the flag, the host's APP_ENVIRONMENT, and the project
#   2  exactly one unfinished row in _prisma_migrations, and it is <name>
#   3  the image carries <name>, and its migration.sql has the checksum Prisma
#      recorded for the failed row — the file that failed is the file analysed
#   4  the API is not running (nothing writes while the evidence is read)
#   5  the file is atomic (scripts/ops/migration-recovery.mjs): no statement
#      ends, splits or refuses the implicit transaction PostgreSQL wraps a
#      multi-statement migration in, so its failure rolled all of it back
#   6  none of the objects the file creates exists in the database now
#   7  (resolve) --database-id is this database, --confirm is the exact phrase
#
# applied_steps_count is printed but proves nothing: Prisma records 0 for a
# file that committed half-way too.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

sha_arg=""
environment="staging"
expected_project="taktic-staging"
migration_arg=""
database_id_arg=""
confirm_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha_arg="${2:?--sha needs a commit}"; shift 2 ;;
    --environment) environment="${2:?--environment needs a value}"; shift 2 ;;
    --project) expected_project="${2:?--project needs a name}"; shift 2 ;;
    --migration) migration_arg="${2:?--migration needs a name}"; shift 2 ;;
    --database-id) database_id_arg="${2:?--database-id needs a value}"; shift 2 ;;
    --confirm) confirm_arg="${2:?--confirm needs the phrase}"; shift 2 ;;
    -h | --help) sed -n '2,45p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$sha_arg" ] || die "usage: migration-recover.sh --sha <commit> [--migration <name> --database-id <id> --confirm <phrase>]"

resolve_mode=0
if [ -n "$migration_arg$database_id_arg$confirm_arg" ]; then
  [ -n "$migration_arg" ] && [ -n "$database_id_arg" ] && [ -n "$confirm_arg" ] \
    || die "--migration, --database-id and --confirm go together; run without them first for the read-only report"
  resolve_mode=1
fi

# 1 — staging only, before anything else is read.
[ "$environment" = "staging" ] \
  || die "refused: --environment $environment. A failed migration on production is never marked rolled back by a script; restore or fix forward (docs/ops/deploy-runtime.md, 'P3009')"
host_environment="$(env_or_file APP_ENVIRONMENT)"
[ "$host_environment" = "staging" ] \
  || die "refused: this host's APP_ENVIRONMENT is '${host_environment:-unset}', not staging"

require_cmd docker git awk sed
require_project_name
[ "$COMPOSE_PROJECT_NAME" = "$expected_project" ] \
  || die "refused: COMPOSE_PROJECT_NAME is $COMPOSE_PROJECT_NAME, expected $expected_project (--project)"
sha="$(resolve_commit "$sha_arg")"
export TAKTIC_IMAGE_TAG="$sha"
image="taktic-migrate:$sha"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)"
[ "$revision" = "$sha" ] || die "$image is missing or mislabelled (the image of the failed deploy is needed)"

container_running "$POSTGRES_CONTAINER" || die "$POSTGRES_CONTAINER is not running"
pg_project="$(container_label "$POSTGRES_CONTAINER" com.docker.compose.project)"
[ "$pg_project" = "$COMPOSE_PROJECT_NAME" ] \
  || die "refused: $POSTGRES_CONTAINER belongs to project '$pg_project', not '$COMPOSE_PROJECT_NAME'"
db_id="$(database_identity)" || die "could not read the database identity (pg_control_system); refusing"
[ -n "$db_id" ] || die "empty database identity; refusing"

work="$(mktemp -d "${TMPDIR:-/tmp}/taktic-recover.XXXXXX")"
trap 'rm -rf "$work"' EXIT

reasons=""
refuse() { reasons="$reasons
  - $*"; }

audit() {
  # One JSON line per attempt. Every value is an identifier the script has
  # validated or computed itself; no row data, no secret.
  [ "$resolve_mode" -eq 1 ] || return 0
  local dir="$BACKUP_ROOT/ops-audit" outcome="$1" detail="$2"
  mkdir -p "$dir"
  chmod 700 "$dir"
  printf '{"ts":"%s","action":"resolve-rolled-back","outcome":"%s","operator":"%s","host":"%s","project":"%s","environment":"%s","sha":"%s","database_id":"%s","migration":"%s","checksum":"%s","applied_steps_count":"%s","detail":"%s"}\n' \
    "$(_ts)" "$outcome" "$(id -un | tr -cd 'A-Za-z0-9._-')" "$(hostname | tr -cd 'A-Za-z0-9._-')" "$COMPOSE_PROJECT_NAME" \
    "$environment" "$sha" "$db_id" "${name:-}" "${checksum:-}" "${steps:-}" "$(printf '%s' "$detail" | tr -d '"\\' | tr '\n' ' ')" \
    >>"$dir/migration-recover.jsonl"
  chmod 600 "$dir/migration-recover.jsonl"
}

step "P3009 recovery check ($COMPOSE_PROJECT_NAME, database $db_id)"

# 2 — the failed row.
rows="$(pg_query_ro 'SELECT migration_name || '"'"'|'"'"' || applied_steps_count || '"'"'|'"'"' || coalesce(checksum, '"'"''"'"') FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at')"
row_count="$(printf '%s\n' "$rows" | grep -c . || true)"
if [ "$row_count" -eq 0 ]; then
  name="$migration_arg"
  audit "noop" "no unfinished migration"
  ok_msg="nothing to resolve: _prisma_migrations has no failed migration"
  [ -z "$migration_arg" ] || ok_msg="$ok_msg ($migration_arg is not in a failed state; it was never failed here, or it is rolled back already)"
  log "$ok_msg"
  exit 0
fi
[ "$row_count" -eq 1 ] || die "refused: $row_count unfinished migrations; one at a time can be proven, not this — restore or fix forward"
name="${rows%%|*}"
rest="${rows#*|}"
steps="${rest%%|*}"
checksum="${rest#*|}"
log "failed migration: $name (applied_steps_count=$steps, recorded checksum ${checksum:0:12}…)"
grep -Eq '^[0-9]{14}_[a-z0-9_]+$' <<<"$name" || die "refused: '$name' is not a migration directory name"
if [ -n "$migration_arg" ] && [ "$migration_arg" != "$name" ]; then
  audit "refused" "--migration $migration_arg is not the failed migration"
  die "refused: --migration $migration_arg is not the failed migration ($name); a migration that is not failed is never resolved"
fi

# 3 — the file that failed. Listed first, matched after: `docker run … | grep -q`
# under pipefail fails on SIGPIPE when grep stops reading early.
image_names="$(docker run --rm --network none "$image" migrations)" || image_names=""
if grep -qx -- "$name" <<<"$image_names"; then
  docker run --rm --network none --entrypoint cat "$image" "/app/prisma/migrations/$name/migration.sql" >"$work/migration.sql" \
    || refuse "could not read $name/migration.sql from $image"
  file_sum="$(sha256_of "$work/migration.sql")"
  if [ "$file_sum" = "$checksum" ]; then
    log "the image's $name/migration.sql has the checksum Prisma recorded"
  else
    refuse "the image's migration.sql ($file_sum) is not the file that failed (recorded $checksum)"
  fi
else
  refuse "$image does not carry $name"
fi

# 4 — no writer.
if container_running "$API_CONTAINER"; then
  refuse "$API_CONTAINER is running; stop it (it is stopped after a failed deploy) so nothing writes while the evidence is read"
else
  log "$API_CONTAINER is not running"
fi

# 5 + 6 — atomic, and nothing it creates exists.
if [ -s "$work/migration.sql" ]; then
  set +e
  analysis="$(ops_node migration-recovery.mjs analyze <"$work/migration.sql")"
  analysis_code=$?
  set -e
  printf '%s\n' "$analysis" | sed 's/^/       /' >&2
  if [ "$analysis_code" -ne 0 ]; then
    refuse "the file is not atomic: part of it may have been committed before the failure (BLOCKER lines above)"
  fi
  verify_sql="$(ops_node migration-recovery.mjs verify-sql <"$work/migration.sql")"
  if present="$(pg_query_ro "$verify_sql")"; then
    checked="$(printf '%s\n' "$present" | grep -c . || true)"
    found="$(printf '%s\n' "$present" | awk -F'|' '$3 == 1 { print $1 " " $2 }')"
    if [ -n "$found" ]; then
      printf '%s\n' "$found" | sed 's/^/       present: /' >&2
      refuse "objects this migration creates exist in the database (partial DDL, or created before it): a rolled-back mark would let the next deploy run into them"
    else
      log "none of the $checked object(s) the file creates exists"
    fi
  else
    refuse "the object check could not run"
  fi
fi

if [ -n "$reasons" ]; then
  audit "refused" "$reasons"
  printf '\n%s  NOT RESOLVABLE: %s cannot be proven to have left nothing behind:%s\n' "$(_ts)" "$name" "$reasons" >&2
  cat >&2 <<EOF

       Do not mark it rolled back. Recover by one of (docs/ops/deploy-runtime.md, "P3009"):
         a. restore the pre-deploy dump the failed deploy took (step 5) into a
            fresh database, verify it with restore-rehearsal.sh, then deploy again;
         b. fix forward: a person inspects the partial state, completes or undoes
            it by a reviewed SQL change, and only then marks the migration with
            a reviewed, manual \`prisma migrate resolve\` outside this tool.
EOF
  exit 1
fi

phrase="rolled-back $name on $db_id"
if [ "$resolve_mode" -eq 0 ]; then
  step "RESOLVABLE: $name failed atomically and left nothing behind"
  cat >&2 <<EOF
       Fix the cause first (for $name: the data the guard counted — preflight 7b
       must pass), then mark it rolled back with:

         scripts/ops/migration-recover.sh --sha $sha \\
           --migration $name \\
           --database-id '$db_id' \\
           --confirm '$phrase'

       and run the deploy again. This report changed nothing.
EOF
  exit 0
fi

# 7 — the operator's confirmation names this migration on this database.
if [ "$database_id_arg" != "$db_id" ]; then
  audit "refused" "database id mismatch"
  die "refused: --database-id is not this database ($db_id)"
fi
if [ "$confirm_arg" != "$phrase" ]; then
  audit "refused" "confirmation phrase mismatch"
  die "refused: --confirm must be exactly: $phrase"
fi

audit "attempt" "all checks passed"
step "Marking $name rolled back"
set +e
resolve_out="$(prod_compose --profile tools run --rm --no-deps -T -e "TAKTIC_RESOLVE_CONFIRM=$name" migrate resolve-rolled-back "$name" 2>&1)"
resolve_code=$?
set -e
printf '%s\n' "$resolve_out" | grep -vE '^\s*$' | sed 's/^/       /' >&2
left="$(unfinished_migrations)"
marked="$(pg_query_ro "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$name' AND rolled_back_at IS NOT NULL")"
if [ "$resolve_code" -ne 0 ] || [ -n "$left" ] || [ "${marked:-0}" -lt 1 ]; then
  audit "failed" "resolve exit $resolve_code; unfinished left: ${left:-none}; rolled-back rows: ${marked:-0}"
  die "the rolled-back mark did not take (exit $resolve_code); nothing else was changed"
fi
audit "resolved" "rolled-back rows: $marked"
step "$name is marked rolled back; no failed migration is left"
log "audit: $BACKUP_ROOT/ops-audit/migration-recover.jsonl"
log "next: fix the cause, then scripts/ops/deploy-staging.sh --sha <commit> --check, then the deploy"
