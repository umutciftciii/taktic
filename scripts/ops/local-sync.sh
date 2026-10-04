#!/usr/bin/env bash
# Bring the local development stack up to a merged commit, migrations first.
#
#   scripts/ops/local-sync.sh [--ref origin/main] [--dry-run]
#
# For the developer machine's main checkout and its docker-compose.yml +
# docker-compose.local.yml stack. That stack bind-mounts the checkout and
# hot-reloads: the moment `git pull` lands a commit whose Prisma schema has a
# new column, the running API reloads and queries a column the database does
# not have yet. So the order is enforced here the same way the deploy script
# enforces it on a server:
#
#   1  checks     clean tracked tree, target is a fast-forward of HEAD, the
#                 dev PostgreSQL is up (its compose project is read from the
#                 container, never guessed — see the `-p` trap)
#   2  image      taktic-migrate:<target> from `git archive` (no checkout move)
#   3  stop       the dev API container
#   4  pull       `git merge --ff-only <target>`
#   5  status     exact pending list (image vs _prisma_migrations)
#   6  backup     scripts/ops/backup-db.sh --label pre-sync-<sha>
#   7  migrate    `prisma migrate deploy`, then status + drift must be clean
#   8  recreate   api, web, admin (`up -d --no-deps --force-recreate`; the
#                 API container regenerates its Prisma client on start)
#   9  smoke      GET /health on the API
#
# PostgreSQL is never recreated. --dry-run runs steps 1, 2 and 5 for real and
# prints everything else.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

ref="origin/main"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) ref="${2:?--ref needs a ref}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
export DRY_RUN
require_cmd docker git curl comm

step "1. Checks"
git -C "$REPO_ROOT" fetch --quiet origin || die "git fetch origin failed"
target="$(resolve_commit "$ref")"
head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
{ git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet; } || die "tracked files have local changes"
git -C "$REPO_ROOT" merge-base --is-ancestor "$head" "$target" || die "$ref is not a fast-forward of HEAD ($head)"
require_postgres_ready
project="$(container_label "$POSTGRES_CONTAINER" com.docker.compose.project)"
[ -n "$project" ] || die "$POSTGRES_CONTAINER carries no compose project label"
network="$(docker container inspect -f '{{range $name, $n := .NetworkSettings.Networks}}{{$name}} {{end}}' "$POSTGRES_CONTAINER" | awk '{print $1}')"
log "HEAD $head -> $target ($ref); compose project $project; network $network"
dev_compose() {
  docker compose -p "$project" --project-directory "$REPO_ROOT" \
    -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/docker-compose.local.yml" "$@"
}

step "2. Migration image for $target"
"$OPS_DIR/build-images.sh" "$target" --targets migrate >/dev/null
image="taktic-migrate:$target"

# DATABASE_URL for the migrate container, from the dev PostgreSQL's own
# environment. Held in this process and the throwaway container only.
pg_user="$(pg_container_user)"
pg_db="$(pg_container_db)"
pg_password="$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_PASSWORD)"
migrate() {
  docker run --rm --network "$network" \
    -e "DATABASE_URL=postgresql://${pg_user}:${pg_password}@postgres:5432/${pg_db}?schema=public" \
    "$image" "$1"
}

pending_list() {
  comm -23 <(image_migrations "$image") <(applied_migrations) | grep . || true
}

step "3. Stopping $API_CONTAINER (it would hot-reload the new schema before its migration)"
run_mut docker stop --time 30 "$API_CONTAINER" >/dev/null

step "4. Fast-forward to $target"
run_mut git -C "$REPO_ROOT" merge --ff-only --quiet "$target"

step "5. Pending migrations"
unknown="$(comm -13 <(image_migrations "$image") <(applied_migrations) | grep . || true)"
[ -z "$unknown" ] || die "database has migrations $target does not contain:$(printf ' %s' $unknown)"
[ -z "$(unfinished_migrations)" ] || die "database has an unfinished (failed) migration"
pending="$(pending_list)"
if [ -z "$pending" ]; then log "none"; else printf '%s\n' "$pending" | sed 's/^/       pending: /' >&2; fi

step "6. Backup"
run_mut "$OPS_DIR/backup-db.sh" --label "pre-sync-${target:0:12}" >/dev/null

step "7. Migrate"
if [ -n "$pending" ]; then
  run_mut migrate deploy
fi
if [ "$DRY_RUN" != 1 ]; then
  status_out="$(migrate status 2>&1)" || die "migrate status is not clean"
  case "$status_out" in *"Database schema is up to date"*) ;; *) die "migrate status is not clean" ;; esac
  migrate drift >/dev/null || die "drift: the database differs from $target's schema.prisma; containers left stopped"
  log "schema up to date, no drift"
fi

step "8. Recreating api, web, admin"
run_mut dev_compose up -d --no-deps --force-recreate api web admin

step "9. Smoke"
if [ "$DRY_RUN" != 1 ]; then
  port="$(env_or_file API_PORT)"
  port="${port:-3001}"
  waited=0
  until curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    [ "$waited" -lt 600 ] || die "API did not answer /health within 600s (docker logs $API_CONTAINER)"
    sleep 5
    waited=$((waited + 5))
  done
  log "API healthy on :$port"
fi
step "Local stack at $target$([ "$DRY_RUN" = 1 ] && echo ' (dry run: nothing changed)')"
