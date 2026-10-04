#!/usr/bin/env bash
# Migration-safe deploy of one commit to a staging (or production) host.
#
#   scripts/ops/deploy-staging.sh --sha <commit> [options]
#
#   --check                         the read-only preflight, then stop. No
#                                   git fetch, no image build, no log file, no
#                                   directory created; nothing stopped,
#                                   checked out, migrated or recreated. Images
#                                   not built yet are reported, and the checks
#                                   that need them are marked NOT RUN (exit 3)
#                                   — build them with scripts/ops/build-images.sh
#                                   <sha> for a complete check (exit 0)
#   --dry-run                       run every read-only step, print every
#                                   mutating command instead of running it
#   --environment <staging|production> default staging; the runtime contract
#                                   the preflight checks (deploy-preflight.sh)
#   --project <name>                the compose project that must own the
#                                   volumes (default for staging: taktic-staging)
#   --deploy-ref <ref>              default origin/main
#   --backup <file.dump>            verify this existing dump instead of
#                                   taking a fresh one (see step 5)
#   --allow-empty-uploads           an empty uploads volume is not an error
#   --fix-uploads-ownership         give the API's mounted uploads volume to
#                                   the image's runtime uid:gid (step 1b)
#   --accept-env-drop               } passed through to the preflight;
#   --accept-legacy-postgres-publish} see deploy-preflight.sh
#   --skip-build                    images must already exist
#
# The order is the contract, and the script stops at the first failure:
#
#    0  build     taktic-*:<sha> from `git archive <sha>` (touches nothing
#                 that runs; skipped when the images exist)
#    1  preflight scripts/ops/deploy-preflight.sh — every check, read-only,
#                 including the runtime contract and the new API image's own
#                 boot checks: a configuration the new build would refuse
#                 stops the deploy here, while the old API still serves
#   1b uploads   (--fix-uploads-ownership) the mounted uploads volume is given
#                 to the runtime uid:gid, content verified unchanged
#    2  stop      the API container. From here on no old code can write and
#                 no new code is running.
#    3  checkout  `git checkout --detach <sha>` — only now, with the API down
#    4  status    `prisma migrate status` + exact pending list
#    5  backup    a fresh pg_dump (or --backup verified): sha256, pg_restore
#                 --list, and migration count equal to the live database;
#                 plus the uploads volume
#    6  migrate   `prisma migrate deploy`, nothing else (the image's guard
#                 refuses dev, reset, db push and shadow databases)
#    7  verify    status must say up to date; the drift check must find no
#                 difference between the database and this commit's schema
#    8  api       recreated from taktic-api:<sha>, waited until healthy
#    9  web/admin recreated from their <sha> images, waited until healthy
#   10  smoke     health, pages, security headers, image revisions, and
#                 PostgreSQL's container id unchanged from step 1
#
# PostgreSQL is never created, recreated, restarted or stopped by this
# script: every compose command is `--no-deps` and names its services.
#
# Do not run this against staging/production from a pull request; it is for
# the host's operator. Everything is logged to $TAKTIC_BACKUP_DIR/deploy-logs.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

original_args=("$@")
sha_arg=""
deploy_ref="origin/main"
check_only=0
backup_arg=""
allow_empty_uploads=0
fix_uploads=0
skip_build=0
preflight_flags=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha_arg="${2:?--sha needs a commit}"; shift 2 ;;
    --deploy-ref) deploy_ref="${2:?--deploy-ref needs a ref}"; shift 2 ;;
    --check) check_only=1; shift ;;
    --environment | --project) preflight_flags="$preflight_flags $1 ${2:?$1 needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --backup) backup_arg="${2:?--backup needs a file}"; shift 2 ;;
    --allow-empty-uploads) allow_empty_uploads=1; shift ;;
    --fix-uploads-ownership) fix_uploads=1; preflight_flags="$preflight_flags --allow-uploads-ownership-fix"; shift ;;
    --accept-env-drop | --accept-legacy-postgres-publish) preflight_flags="$preflight_flags $1"; shift ;;
    --skip-build) skip_build=1; shift ;;
    -h | --help) sed -n '2,64p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$sha_arg" ] || die "usage: deploy-staging.sh --sha <commit> [options]"
export DRY_RUN

require_cmd docker git awk sed comm
require_project_name
# --check reads what the host already has: no fetch (the commit must be here
# already; `git fetch origin` first otherwise).
if [ "$check_only" -eq 0 ]; then
  git -C "$REPO_ROOT" fetch --quiet origin || die "git fetch origin failed"
fi
sha="$(resolve_commit "$sha_arg")"
export TAKTIC_IMAGE_TAG="$sha"
short="${sha:0:12}"

# Run the deploy with the *target* commit's scripts and compose file, never
# with whatever the checkout happens to hold: step 3 moves the checkout, and
# a script that changes under its own feet — or a first deploy from a
# checkout that predates these scripts — would mix two versions. The target's
# scripts/ops and docker-compose.prod.yml are extracted with `git archive`
# into a staging directory, and this script re-executes from there once.
if [ "${TAKTIC_DEPLOY_STAGED:-}" != "$sha" ]; then
  stage="$(mktemp -d "${TMPDIR:-/tmp}/taktic-deploy-$short.XXXXXX")"
  git -C "$REPO_ROOT" archive --format=tar "$sha" scripts/ops docker-compose.prod.yml | tar -x -C "$stage" \
    || die "commit $sha does not carry scripts/ops and docker-compose.prod.yml"
  log "running the deploy scripts of $short from $stage"
  TAKTIC_DEPLOY_STAGED="$sha" TAKTIC_REPO_ROOT="$REPO_ROOT" TAKTIC_PROD_COMPOSE_FILE="$stage/docker-compose.prod.yml" \
    exec "$stage/scripts/ops/deploy-staging.sh" "${original_args[@]}"
fi

# --check: the preflight alone, read-only, and nothing written — not even a
# log file. Images are not built; whatever needs them is reported NOT RUN.
if [ "$check_only" -eq 1 ]; then
  log "check $sha against project $COMPOSE_PROJECT_NAME (read-only; nothing is fetched, built or written)"
  set +e
  # shellcheck disable=SC2086
  "$OPS_DIR/deploy-preflight.sh" --sha "$sha" --deploy-ref "$deploy_ref" --skip-fetch --allow-missing-images $preflight_flags
  check_code=$?
  set -e
  case "$check_code" in
    0) step "--check: preflight passed; nothing was changed" ;;
    3) step "--check: no failure, but checks that need the images were NOT RUN; nothing was changed" ;;
    *) step "--check: preflight FAILED; nothing was changed" ;;
  esac
  exit "$check_code"
fi

log_dir="$BACKUP_ROOT/deploy-logs"
mkdir -p "$log_dir"
log_file="$log_dir/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$short.log"
exec 2> >(tee -a "$log_file" >&2)
log "deploy $sha to project $COMPOSE_PROJECT_NAME (dry-run=$DRY_RUN, log $log_file)"

current_step="start"
api_stopped=0
migrated=0
finished=0
on_exit() {
  local code=$?
  [ "$finished" -eq 1 ] && return 0
  [ "$code" -ne 0 ] || code=1
  printf '\n%s  FAIL deploy stopped at step: %s (exit %s)\n' "$(_ts)" "$current_step" "$code" >&2
  if [ "$migrated" -eq 1 ]; then
    printf '%s       Migrations HAVE been applied. Do not start the previous API image on the new schema.\n' "$(_ts)" >&2
    printf '%s       Fix forward (rerun this script once the cause is fixed) or restore the pre-deploy dump: docs/ops/deploy-runtime.md, "Rollback".\n' "$(_ts)" >&2
  elif [ "$api_stopped" -eq 1 ]; then
    printf '%s       No migration was applied. The previous API can be started again: docker start %s\n' "$(_ts)" "$API_CONTAINER" >&2
    printf '%s       (and, if the checkout moved: git -C %s checkout --detach %s)\n' "$(_ts)" "$REPO_ROOT" "$previous_head" >&2
  fi
  exit "$code"
}
trap on_exit EXIT

previous_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# --- 0 build ---------------------------------------------------------------------
current_step="0 build"
step "0. Images for $sha"
if [ "$skip_build" -eq 1 ]; then
  log "--skip-build: the preflight checks that the images exist"
else
  run_mut "$OPS_DIR/build-images.sh" "$sha"
fi

# --- 1 preflight -----------------------------------------------------------------
current_step="1 preflight"
step "1. Preflight"
# shellcheck disable=SC2086
"$OPS_DIR/deploy-preflight.sh" --sha "$sha" --deploy-ref "$deploy_ref" --skip-fetch $preflight_flags
postgres_id="$(container_id "$POSTGRES_CONTAINER")"
log "PostgreSQL container id: ${postgres_id:0:12} (must be the same at the end)"

# --- 1b uploads ownership ---------------------------------------------------------
# Before anything is stopped or migrated, so a volume that cannot be fixed
# costs no downtime. Only the volume the API container itself mounts at the
# upload root, and only when it is the one docker-compose.prod.yml mounts too.
if [ "$fix_uploads" -eq 1 ]; then
  current_step="1b uploads ownership"
  step "1b. Uploads volume ownership"
  uploads_volume=""
  expected_volume="${COMPOSE_PROJECT_NAME}_taktic-api-uploads"
  if container_exists "$API_CONTAINER"; then
    uploads_volume="$(api_uploads_volume)"
    [ "$uploads_volume" = "$expected_volume" ] \
      || die "$API_CONTAINER mounts '${uploads_volume:-nothing}' at $UPLOADS_MOUNT_POINT, not $expected_volume; refusing to change ownership"
  elif docker volume inspect "$expected_volume" >/dev/null 2>&1; then
    uploads_volume="$expected_volume"
  fi
  if [ -z "$uploads_volume" ]; then
    log "no uploads volume yet; the first start creates it owned by the runtime user"
  else
    runtime_ids="$(image_runtime_ids "taktic-api:$sha")"
    log "giving $uploads_volume to $runtime_ids (the runtime user of taktic-api:$short)"
    if [ "$DRY_RUN" = 1 ]; then
      run_mut uploads_ownership_fix "$uploads_volume" "$runtime_ids"
    else
      fixed="$(uploads_ownership_fix "$uploads_volume" "$runtime_ids")" \
        || die "the ownership fix of $uploads_volume failed; nothing has been stopped or migrated"
      log "$uploads_volume owned by $runtime_ids, content unchanged ($fixed)"
    fi
  fi
fi

# --- 2 stop the API --------------------------------------------------------------
current_step="2 stop api"
step "2. Stopping $API_CONTAINER"
previous_image=""
if container_exists "$API_CONTAINER"; then
  previous_image="$(docker container inspect -f '{{.Config.Image}}' "$API_CONTAINER")"
  log "previous API image: $previous_image"
  run_mut docker stop --time 30 "$API_CONTAINER" >/dev/null
  if [ "$DRY_RUN" != 1 ]; then
    container_running "$API_CONTAINER" && die "$API_CONTAINER is still running"
  fi
  api_stopped=1
  log "API stopped"
else
  log "no $API_CONTAINER container (first deploy on this host)"
fi

# --- 3 checkout ------------------------------------------------------------------
current_step="3 checkout"
step "3. Checking out $sha (API is down)"
if [ "$DRY_RUN" != 1 ]; then
  { git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet; } \
    || die "tracked files changed since the preflight; refusing to check out"
fi
run_mut git -C "$REPO_ROOT" -c advice.detachedHead=false checkout --quiet --detach "$sha"
if [ "$DRY_RUN" != 1 ]; then
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$sha" ] || die "checkout did not land on $sha"
fi
log "checkout at $sha (was $previous_head)"

# --- 4 migration status ----------------------------------------------------------
current_step="4 migrate status"
step "4. Migration status"
set +e
status_out="$(prod_compose --profile tools run --rm --no-deps -T migrate status 2>&1)"
status_code=$?
set -e
printf '%s\n' "$status_out" | grep -vE '^\s*$' | sed 's/^/       /' >&2
in_image="$(image_migrations "taktic-migrate:$sha")"
in_db="$(applied_migrations)"
pending_list="$(comm -23 <(printf '%s\n' "$in_image") <(printf '%s\n' "$in_db") | grep . || true)"
unknown="$(comm -13 <(printf '%s\n' "$in_image") <(printf '%s\n' "$in_db") | grep . || true)"
[ -z "$unknown" ] || die "database has migrations this commit does not contain:$(printf ' %s' $unknown)"
[ -z "$(unfinished_migrations)" ] || die "database has an unfinished (failed) migration; resolve it by hand first"
case "$status_code" in
  0 | 1) ;;
  *) die "migrate status failed (exit $status_code)" ;;
esac
pending_count="$(printf '%s\n' "$pending_list" | grep -c . || true)"
log "applied: $(printf '%s\n' "$in_db" | grep -c .), pending: $pending_count"
[ -z "$pending_list" ] || printf '%s\n' "$pending_list" | sed 's/^/       pending: /' >&2

# --- 5 backup ----------------------------------------------------------------------
current_step="5 backup"
step "5. Backup"
live_count="$(applied_migration_count)"
if [ -n "$backup_arg" ]; then
  dump="$backup_arg"
  [ -f "$dump" ] || die "backup not found: $dump"
  [ -f "$dump.sha256" ] || die "backup has no .sha256 sidecar"
  [ "$(awk '{print $1}' "$dump.sha256")" = "$(sha256_of "$dump")" ] || die "backup checksum mismatch: $dump"
  # Captured first: `pg_restore --list | grep -q` under pipefail can fail on
  # SIGPIPE when grep stops reading early.
  toc="$(docker exec -i "$POSTGRES_CONTAINER" pg_restore --list <"$dump")" || die "pg_restore cannot read $dump"
  case "$toc" in
    *"TABLE DATA public _prisma_migrations "*) ;;
    *) die "backup does not contain the data of _prisma_migrations" ;;
  esac
  recorded="$(sed -n 's/^migrations_applied=//p' "$dump.manifest" 2>/dev/null || true)"
  [ "$recorded" = "$live_count" ] || die "backup recorded ${recorded:-?} applied migrations, the database has $live_count — it is not a backup of the current state"
  warn "using an existing backup taken at $(sed -n 's/^created_at=//p' "$dump.manifest"); rows written after that moment are not in it"
else
  if [ "$DRY_RUN" = 1 ]; then
    run_mut "$OPS_DIR/backup-db.sh" --label "pre-deploy-$short"
    dump="(dry-run)"
  else
    dump="$("$OPS_DIR/backup-db.sh" --label "pre-deploy-$short" | sed -n 's/^BACKUP_FILE=//p')"
    [ -n "$dump" ] && [ -f "$dump" ] || die "backup-db.sh did not report a file"
    [ "$(awk '{print $1}' "$dump.sha256")" = "$(sha256_of "$dump")" ] || die "fresh backup failed its own checksum"
    recorded="$(sed -n 's/^migrations_applied=//p' "$dump.manifest")"
    [ "$recorded" = "$live_count" ] || die "fresh backup recorded $recorded migrations, database has $live_count"
  fi
fi
log "database backup: $dump"
uploads_flags="--label pre-deploy-$short"
[ "$allow_empty_uploads" -eq 1 ] && uploads_flags="$uploads_flags --allow-empty"
if [ "$DRY_RUN" = 1 ]; then
  # shellcheck disable=SC2086
  run_mut "$OPS_DIR/backup-uploads.sh" $uploads_flags
else
  # shellcheck disable=SC2086
  "$OPS_DIR/backup-uploads.sh" $uploads_flags >/dev/null \
    || die "uploads backup failed (an empty volume needs --allow-empty-uploads)"
fi

# --- 6 migrate deploy ------------------------------------------------------------
current_step="6 migrate deploy"
step "6. prisma migrate deploy"
if [ "$pending_count" -eq 0 ]; then
  log "no pending migration; nothing to apply"
else
  migrated=1
  run_mut prod_compose --profile tools run --rm --no-deps -T migrate deploy
fi

# --- 7 verify ----------------------------------------------------------------------
current_step="7 verify schema"
step "7. Migration status and drift"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] would require: migrate status = up to date, drift = no difference"
else
  status_out="$(prod_compose --profile tools run --rm --no-deps -T migrate status 2>&1)" \
    || die "migrate status is not clean after deploy"
  printf '%s\n' "$status_out" | grep -q "Database schema is up to date" || die "migrate status does not report up to date"
  set +e
  drift_out="$(prod_compose --profile tools run --rm --no-deps -T migrate drift 2>&1)"
  drift_code=$?
  set -e
  printf '%s\n' "$drift_out" | grep -vE '^\s*$' | head -n 40 | sed 's/^/       /' >&2
  [ "$drift_code" -eq 0 ] || die "drift check exit $drift_code: the database schema differs from this commit's schema.prisma; the API is NOT started"
  log "schema up to date, no drift"
fi

# --- 8 api -------------------------------------------------------------------------
current_step="8 api"
step "8. Recreating the API from taktic-api:$sha"
run_mut prod_compose up -d --no-deps --force-recreate api
[ "$DRY_RUN" = 1 ] || wait_healthy "$API_CONTAINER" 180
log "API healthy"

# --- 9 web / admin -----------------------------------------------------------------
current_step="9 web/admin"
step "9. Recreating web and admin"
run_mut prod_compose up -d --no-deps --force-recreate web admin
if [ "$DRY_RUN" != 1 ]; then
  wait_healthy "$WEB_CONTAINER" 180
  wait_healthy "$ADMIN_CONTAINER" 180
fi
log "web and admin healthy"

# --- 10 smoke ----------------------------------------------------------------------
current_step="10 smoke"
step "10. Smoke"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] would run scripts/ops/smoke.sh --sha $sha"
else
  "$OPS_DIR/smoke.sh" --sha "$sha"
  [ "$(container_id "$POSTGRES_CONTAINER")" = "$postgres_id" ] || die "PostgreSQL container id changed during the deploy"
  log "PostgreSQL container unchanged (${postgres_id:0:12})"
fi

finished=1
if [ "$DRY_RUN" = 1 ]; then
  step "Dry run complete for $sha: nothing was changed"
  exit 0
fi
step "Deployed $sha (previous checkout $previous_head${previous_image:+, previous API image $previous_image})"
log "backup of the pre-deploy state: $dump"
