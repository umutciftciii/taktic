#!/usr/bin/env bash
# One-time: recreate the PostgreSQL container from docker-compose.prod.yml so
# it stops being published on the host network (OPS-006 cutover).
#
#   scripts/ops/postgres-cutover.sh --confirm-recreate-postgres [--dry-run]
#
# The deploy script never touches PostgreSQL, so a host whose database
# container was created by the development compose keeps publishing it (on
# 0.0.0.0 unless an override narrowed it) until this is run once, in a planned
# window. The data lives in the named volume and is not affected by
# recreating the container — this script proves that rather than assuming it:
#
#   1  checks   container belongs to COMPOSE_PROJECT_NAME and mounts
#               <project>_taktic-postgres-data; the running API's image tag is
#               known (it is restarted on the same tag)
#   2  stop     the API (no writes during the switch)
#   3  backup   scripts/ops/backup-db.sh --label pre-postgres-cutover
#   4  recreate `docker compose -f docker-compose.prod.yml up -d --no-deps
#               --force-recreate postgres`
#   5  verify   same data volume, no published port, migration count and
#               every table's row count equal to the backup's manifest
#   6  restart  the API on its previous image, then scripts/ops/smoke.sh
#
# Without --confirm-recreate-postgres it only runs step 1 and says what it
# would do.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

confirmed=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm-recreate-postgres) confirmed=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_cmd docker awk
require_project_name
require_postgres_ready

step "1. Checks"
project="$(container_label "$POSTGRES_CONTAINER" com.docker.compose.project)"
[ "$project" = "$COMPOSE_PROJECT_NAME" ] || die "$POSTGRES_CONTAINER belongs to '$project', not '$COMPOSE_PROJECT_NAME'"
volume_of() {
  docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$POSTGRES_CONTAINER"
}
data_volume="$(volume_of)"
[ "$data_volume" = "${COMPOSE_PROJECT_NAME}_taktic-postgres-data" ] || die "data volume is '$data_volume', expected ${COMPOSE_PROJECT_NAME}_taktic-postgres-data"
container_exists "$API_CONTAINER" || die "no $API_CONTAINER; deploy the production runtime first (deploy-staging.sh)"
api_image="$(docker container inspect -f '{{.Config.Image}}' "$API_CONTAINER")"
case "$api_image" in
  taktic-api:*) export TAKTIC_IMAGE_TAG="${api_image#taktic-api:}" ;;
  *) die "$API_CONTAINER runs '$api_image', not a production image; deploy the production runtime first" ;;
esac
published="$(docker container inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$POSTGRES_CONTAINER")"
log "project $project, volume $data_volume, published: ${published:-nothing}, API image tag $TAKTIC_IMAGE_TAG"
if [ "$confirmed" -ne 1 ]; then
  step "Not confirmed: would stop the API, back up, recreate $POSTGRES_CONTAINER from docker-compose.prod.yml, verify, restart the API"
  exit 0
fi

step "2. Stopping $API_CONTAINER"
run_mut docker stop --time 30 "$API_CONTAINER" >/dev/null

step "3. Backup"
if [ "$DRY_RUN" = 1 ]; then
  run_mut "$OPS_DIR/backup-db.sh" --label pre-postgres-cutover
  dump="(dry-run)"
else
  dump="$("$OPS_DIR/backup-db.sh" --label pre-postgres-cutover | sed -n 's/^BACKUP_FILE=//p')"
  [ -f "$dump" ] || die "backup failed; the API is stopped — start it with: docker start $API_CONTAINER"
fi

step "4. Recreating $POSTGRES_CONTAINER"
run_mut prod_compose up -d --no-deps --force-recreate postgres
[ "$DRY_RUN" = 1 ] || wait_healthy "$POSTGRES_CONTAINER" 120

step "5. Verifying"
if [ "$DRY_RUN" != 1 ]; then
  [ "$(volume_of)" = "$data_volume" ] || die "recreated container mounts '$(volume_of)', not $data_volume"
  now_published="$(docker container inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$POSTGRES_CONTAINER")"
  [ -z "$now_published" ] || die "still published: $now_published"
  [ "$(applied_migration_count)" = "$(sed -n 's/^migrations_applied=//p' "$dump.manifest")" ] || die "migration count differs from the backup"
  mismatches=0
  while IFS='=' read -r key value; do
    table="${key#rows.}"
    got="$(pg_query "SELECT count(*) FROM public.\"$table\"")"
    if [ "$got" != "$value" ]; then
      printf '%s  FAIL %s: %s rows, backup had %s\n' "$(_ts)" "$table" "$got" "$value" >&2
      mismatches=$((mismatches + 1))
    fi
  done <<EOF
$(grep '^rows\.' "$dump.manifest")
EOF
  [ "$mismatches" -eq 0 ] || die "$mismatches table(s) differ from the backup; the API stays stopped"
  log "same volume, not published, every table's row count matches the backup"
fi

step "6. Restarting the API on $api_image"
run_mut prod_compose up -d --no-deps api
if [ "$DRY_RUN" != 1 ]; then
  wait_healthy "$API_CONTAINER" 180
  "$OPS_DIR/smoke.sh"
fi
step "PostgreSQL is no longer published on the host (backup: $dump)"
