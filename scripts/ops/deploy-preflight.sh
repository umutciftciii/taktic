#!/usr/bin/env bash
# Deploy preflight: every check the deploy needs, and nothing that changes
# anything (OPS-004 / OPS-006 / migration ordering).
#
#   scripts/ops/deploy-preflight.sh --sha <commit>
#       [--environment staging]           staging | production: what this host
#                                         is; the runtime contract (5b) is
#                                         checked against it
#       [--project <name>]                the compose project that must own the
#                                         volumes (default for staging:
#                                         taktic-staging; production: required)
#       [--deploy-ref origin/main]        the target must be reachable from it
#       [--skip-fetch]                    do not `git fetch` first
#       [--allow-missing-images]          images not built yet is a warning, and
#                                         the checks that need them (5c, 7) are
#                                         reported as not run (exit 3)
#       [--accept-env-drop]               see check 9
#       [--accept-legacy-postgres-publish] see check 6
#       [--allow-uploads-ownership-fix]   see check 8 (the deploy fixes it)
#
# Read-only by construction: no container is stopped or recreated, nothing is
# built, no directory is created, the checkout is not moved, and the only
# things executed against the database are `prisma migrate status` (through
# the migrate image's guard) and a few SELECTs. The containers it starts are
# throwaway `--rm` ones: `migrate status`, the API image's boot-configuration
# check (5c), and read-only helpers that inspect the uploads volume. Run it as
# often as you like; deploy-staging.sh runs it before it stops anything and
# stops on any FAIL.
#
# Exit status: 0 every check passed; 1 at least one FAIL; 3 no FAIL, but
# checks that need the images were not run (--allow-missing-images).
#
#   1  tools                docker, git, docker compose v2
#   2  project              COMPOSE_PROJECT_NAME set (never guessed)
#   3  repository           target is a commit, reachable from the deploy
#                           ref, and the tracked tree is clean
#   4  images               taktic-{api,web,admin,migrate}:<sha> exist, carry
#                           revision=<sha>, and web/admin were built for the
#                           current NEXT_PUBLIC_API_URL
#   5  compose              docker-compose.prod.yml resolves with this .env and
#                           passes scripts/ops/compose-security.mjs
#   5b runtime contract     scripts/ops/runtime-contract.mjs on the resolved
#                           configuration: project name, APP_ENVIRONMENT,
#                           NODE_ENV=production, PROMOTION_FINGERPRINT_KEY,
#                           the payment provider this environment may run,
#                           public URLs, e-mail and Turnstile (names and
#                           PASS/FAIL only, never a value)
#   5c boot configuration   the API image's own boot checks
#                           (dist/boot-config-check.js), run through
#                           `compose run --rm --no-deps` with exactly the
#                           environment the new API will get: whatever the
#                           new build would refuse at startup is found here,
#                           before the API is stopped or anything migrated
#   6  postgres             running, healthy, owned by this project, on the
#                           project's data volume, not published beyond
#                           loopback
#   7  migrations           `migrate status` from the target's migrate image:
#                           up to date, or only pending migrations — never a
#                           failed or diverged history; with nothing pending,
#                           the read-only drift check must find no difference
#   8  uploads              the API's uploads volume is the project's, read
#                           from the API container's own mount; every entry
#                           owned by the image's runtime uid:gid, and no link
#                           or special file in it
#   9  environment          every variable the running API has *with a value*
#                           is still forwarded by the new configuration
#                           (names only; values are never printed)
#   10 backup space         free space for a dump in $TAKTIC_BACKUP_DIR (or,
#                           when it does not exist yet, in the nearest
#                           existing parent the deploy will create it under)

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

sha_arg=""
deploy_ref="origin/main"
environment="staging"
project=""
skip_fetch=0
allow_missing_images=0
accept_env_drop=0
accept_legacy_pg=0
allow_uploads_fix=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha_arg="${2:?--sha needs a commit}"; shift 2 ;;
    --deploy-ref) deploy_ref="${2:?--deploy-ref needs a ref}"; shift 2 ;;
    --environment) environment="${2:?--environment needs staging or production}"; shift 2 ;;
    --project) project="${2:?--project needs a name}"; shift 2 ;;
    --skip-fetch) skip_fetch=1; shift ;;
    --allow-missing-images) allow_missing_images=1; shift ;;
    --accept-env-drop) accept_env_drop=1; shift ;;
    --accept-legacy-postgres-publish) accept_legacy_pg=1; shift ;;
    --allow-uploads-ownership-fix) allow_uploads_fix=1; shift ;;
    -h | --help) sed -n '2,70p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$sha_arg" ] || die "usage: deploy-preflight.sh --sha <commit> [options]"

case "$environment" in
  staging | production) ;;
  *) die "--environment must be staging or production" ;;
esac

failures=0
warnings=0
not_run=0
ok() { printf '%s  ok   %s\n' "$(_ts)" "$*" >&2; }
bad() { printf '%s  FAIL %s\n' "$(_ts)" "$*" >&2; failures=$((failures + 1)); }
note() { warn "$*"; warnings=$((warnings + 1)); }
# A check that needs an image that is not built yet (--allow-missing-images).
skipped() { warn "NOT RUN $*"; not_run=$((not_run + 1)); }

# --- 1 tools ---------------------------------------------------------------
step "1. Tools"
require_cmd docker git awk sed
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available"
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short 2>/dev/null)"

# --- 2 project ---------------------------------------------------------------
step "2. Compose project"
require_project_name
ok "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"

# --- 3 repository --------------------------------------------------------------
step "3. Repository"
git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT is not a git checkout"
if [ "$skip_fetch" -eq 0 ]; then
  git -C "$REPO_ROOT" fetch --quiet origin || die "git fetch origin failed"
fi
sha="$(resolve_commit "$sha_arg")"
export TAKTIC_IMAGE_TAG="$sha"
ok "target commit $sha"
if git -C "$REPO_ROOT" merge-base --is-ancestor "$sha" "$deploy_ref" 2>/dev/null; then
  ok "reachable from $deploy_ref"
else
  bad "$sha is not reachable from $deploy_ref (only reviewed, merged commits are deployed)"
fi
if git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet; then
  ok "tracked working tree is clean"
else
  bad "tracked files have local changes; the deploy would check out over them:"
  git -C "$REPO_ROOT" status --short --untracked-files=no >&2
fi
head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
log "checkout is at $head$([ "$head" = "$sha" ] && echo ' (already the target)')"
if [ -f "$REPO_ROOT/docker-compose.override.yml" ]; then
  note "docker-compose.override.yml exists and is IGNORED by -f docker-compose.prod.yml; any setting it carries must move to .env"
fi

# --- 4 images ------------------------------------------------------------------
step "4. Images for $sha"
api_url="$(env_or_file NEXT_PUBLIC_API_URL)"
web_url="$(env_or_file NEXT_PUBLIC_WEB_URL)"
for target in api web admin migrate; do
  tag="taktic-$target:$sha"
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag" 2>/dev/null || true)"
  if [ -z "$revision" ] && [ "$allow_missing_images" -eq 1 ]; then
    note "$tag not built yet (scripts/ops/build-images.sh $sha; the deploy builds it in its step 0)"
    continue
  fi
  if [ "$revision" != "$sha" ]; then
    bad "$tag missing or mislabelled; run scripts/ops/build-images.sh $sha"
    continue
  fi
  case "$target" in
    web | admin)
      built_for="$(docker image inspect -f '{{index .Config.Labels "taktic.next-public-api-url"}}' "$tag")"
      if [ "$built_for" != "$api_url" ]; then
        bad "$tag was built for NEXT_PUBLIC_API_URL=$built_for, this host says $api_url"
        continue
      fi
      ;;
  esac
  ok "$tag"
done

# --- 5 compose -----------------------------------------------------------------
step "5. docker-compose.prod.yml"
if config_json="$(prod_compose --profile tools config --format json 2>"${TMPDIR:-/tmp}/taktic-preflight-compose.err")"; then
  # Success needs the audit's own verdict line, not only exit 0: a tool that
  # silently audited nothing must not read as a pass.
  if audit="$(printf '%s' "$config_json" | ops_node compose-security.mjs prod --stdin 2>&1)" \
    && printf '%s\n' "$audit" | grep -qx 'compose-security: prod stack OK'; then
    printf '%s\n' "$audit" | sed 's/^/       /' >&2
    ok "configuration resolves and passes the security audit"
  else
    printf '%s\n' "$audit" | sed 's/^/       /' >&2
    bad "docker-compose.prod.yml fails the security audit with this host's .env"
  fi
else
  bad "docker-compose.prod.yml does not resolve: $(cat "${TMPDIR:-/tmp}/taktic-preflight-compose.err")"
  config_json=""
fi
rm -f "${TMPDIR:-/tmp}/taktic-preflight-compose.err"

# --- 5b runtime contract -------------------------------------------------------
step "5b. Runtime contract ($environment)"
if [ -n "$config_json" ]; then
  contract_args="--environment $environment"
  [ -z "$project" ] || contract_args="$contract_args --project $project"
  # Names and PASS/FAIL only: the tool never prints a value it was given.
  # shellcheck disable=SC2086
  if contract="$(printf '%s' "$config_json" | ops_node runtime-contract.mjs $contract_args \
      --next-public-api-url "$api_url" --next-public-web-url "$web_url" 2>&1)" \
    && printf '%s\n' "$contract" | grep -qx 'runtime-contract: OK'; then
    printf '%s\n' "$contract" | sed 's/^/       /' >&2
    ok "the resolved configuration satisfies the $environment runtime contract"
  else
    printf '%s\n' "$contract" | sed 's/^/       /' >&2
    bad "the resolved configuration breaks the $environment runtime contract (FAIL lines above)"
  fi
else
  bad "skipped: the configuration did not resolve"
fi

# --- 5c boot configuration -----------------------------------------------------
step "5c. API boot configuration (taktic-api:$sha)"
if ! docker image inspect "taktic-api:$sha" >/dev/null 2>&1; then
  if [ "$allow_missing_images" -eq 1 ]; then
    skipped "the API image is not built; its boot checks run in the deploy's own preflight, before the API is stopped"
  else
    bad "skipped: taktic-api:$sha does not exist"
  fi
elif [ -z "$config_json" ]; then
  bad "skipped: the configuration did not resolve"
else
  # A throwaway container of the new image with the new API's exact
  # environment, running only the boot checks: no database connection, no
  # listener, no dependency started (--no-deps), removed on exit (--rm).
  set +e
  boot_out="$(prod_compose run --rm --no-deps -T api node dist/boot-config-check.js 2>&1)"
  boot_code=$?
  set -e
  printf '%s\n' "$boot_out" | grep -E '^(ok|FAIL) |^boot-config: ' | sed 's/^/       /' >&2
  if [ "$boot_code" -eq 0 ] && printf '%s\n' "$boot_out" | grep -qx 'boot-config: OK'; then
    ok "the new API accepts this configuration at boot"
  else
    bad "the new API would refuse to start with this configuration (FAIL lines above); nothing has been stopped or migrated"
  fi
fi

# --- 6 postgres ----------------------------------------------------------------
step "6. PostgreSQL ($POSTGRES_CONTAINER)"
pg_ok=0
if ! container_running "$POSTGRES_CONTAINER"; then
  bad "$POSTGRES_CONTAINER is not running (the deploy never creates or recreates PostgreSQL)"
else
  health="$(container_health "$POSTGRES_CONTAINER")"
  [ "$health" = "healthy" ] && ok "running, healthy" || bad "health is '$health'"
  project="$(container_label "$POSTGRES_CONTAINER" com.docker.compose.project)"
  [ "$project" = "$COMPOSE_PROJECT_NAME" ] && ok "compose project $project" \
    || bad "belongs to compose project '$project', not '$COMPOSE_PROJECT_NAME' (wrong project name = empty new volumes)"
  data_volume="$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$POSTGRES_CONTAINER")"
  [ "$data_volume" = "${COMPOSE_PROJECT_NAME}_taktic-postgres-data" ] && ok "data volume $data_volume" \
    || bad "data volume is '$data_volume', docker-compose.prod.yml expects ${COMPOSE_PROJECT_NAME}_taktic-postgres-data"
  published="$(docker container inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}} {{end}}{{end}}' "$POSTGRES_CONTAINER")"
  wide=""
  for ip in $published; do
    case "$ip" in 127.0.0.1 | ::1) ;; *) wide="$wide $ip" ;; esac
  done
  if [ -z "$published" ]; then
    ok "not published on any host address"
  elif [ -z "$wide" ]; then
    note "published on loopback ($published); docker-compose.prod.yml publishes nothing — it takes effect the next time PostgreSQL is recreated (a separate, planned step)"
  elif [ "$accept_legacy_pg" -eq 1 ]; then
    note "published on$wide — accepted by --accept-legacy-postgres-publish; recreate PostgreSQL from docker-compose.prod.yml in a planned window (docs/ops/deploy-runtime.md)"
  else
    bad "published on$wide (reachable from the network). The deploy never recreates PostgreSQL; see docs/ops/deploy-runtime.md, 'PostgreSQL publish cutover', or pass --accept-legacy-postgres-publish"
  fi
  if docker exec "$POSTGRES_CONTAINER" pg_isready -q -U "$(pg_container_user)" -d "$(pg_container_db)"; then
    pg_ok=1
    ok "accepting connections; $(applied_migration_count) migrations applied"
  else
    bad "not accepting connections"
  fi
fi

# --- 7 migrations --------------------------------------------------------------
step "7. Migration status (taktic-migrate:$sha)"
if [ "$pg_ok" -eq 1 ] && docker image inspect "taktic-migrate:$sha" >/dev/null 2>&1; then
  set +e
  status_out="$(prod_compose --profile tools run --rm --no-deps -T migrate status 2>&1)"
  status_code=$?
  set -e
  printf '%s\n' "$status_out" | grep -vE '^\s*$|package\.json#prisma|pris\.ly/prisma-config' | sed 's/^/       /' >&2
  in_image="$(image_migrations "taktic-migrate:$sha")"
  in_db="$(applied_migrations)"
  pending="$(comm -23 <(printf '%s\n' "$in_image") <(printf '%s\n' "$in_db") | grep -c . || true)"
  unknown="$(comm -13 <(printf '%s\n' "$in_image") <(printf '%s\n' "$in_db") | grep . || true)"
  unfinished="$(unfinished_migrations)"
  log "image carries $(printf '%s\n' "$in_image" | grep -c .) migrations; database has applied $(printf '%s\n' "$in_db" | grep -c .); pending: $pending"
  [ -z "$unknown" ] || bad "the database has applied migrations this commit does not contain (deploying would run older code on a newer schema):$(printf ' %s' $unknown)"
  [ -z "$unfinished" ] || bad "unfinished (failed) migrations in _prisma_migrations:$(printf ' %s' $unfinished)"
  # With nothing to apply, the live schema must already be exactly this
  # commit's. Checked here, before the deploy stops anything, so a drifted
  # database costs no downtime. With pending migrations the comparison can
  # only be made after they are applied (deploy step 7).
  if [ "$pending" -eq 0 ] && [ -z "$unknown" ]; then
    set +e
    drift_out="$(prod_compose --profile tools run --rm --no-deps -T migrate drift 2>&1)"
    drift_code=$?
    set -e
    case "$drift_code" in
      0) ok "drift check: the live schema matches $sha's schema.prisma" ;;
      2)
        printf '%s\n' "$drift_out" | grep -vE '^\s*$|Container ' | head -n 40 | sed 's/^/       /' >&2
        bad "drift: the live schema differs from $sha's schema.prisma (changes made outside migrations)" ;;
      *) bad "drift check failed (exit $drift_code)" ;;
    esac
  fi
  case "$status_code:$status_out" in
    0:*"Database schema is up to date"*) ok "database is up to date with $sha (no migration to apply)" ;;
    *"failed"* | *"Failed"* | *"diverge"* | *"not found locally"*)
      bad "migration history is not clean (failed, diverged, or applied migrations this commit does not have); stop and investigate" ;;
    1:*"have not yet been applied"*) ok "pending migrations listed above will be applied by migrate deploy" ;;
    *) bad "migrate status failed (exit $status_code)" ;;
  esac
elif [ "$pg_ok" -eq 1 ] && [ "$allow_missing_images" -eq 1 ]; then
  skipped "the migrate image is not built; the migration status runs in the deploy's own preflight"
else
  bad "skipped: PostgreSQL or the migrate image is not available"
fi

# --- 8 uploads -----------------------------------------------------------------
step "8. Uploads volume"
expected_volume="${COMPOSE_PROJECT_NAME}_taktic-api-uploads"
# The volume to inspect is the one the API container actually mounts at the
# upload root — never a name assembled from the project — and only when it is
# the one docker-compose.prod.yml will mount too.
uploads_volume=""
if container_exists "$API_CONTAINER"; then
  current_volume="$(api_uploads_volume)"
  if [ -z "$current_volume" ]; then
    bad "$API_CONTAINER has no volume at $UPLOADS_MOUNT_POINT"
  elif [ "$current_volume" != "$expected_volume" ]; then
    bad "$API_CONTAINER uses '$current_volume'; docker-compose.prod.yml would mount '$expected_volume' and the uploads would seem to vanish"
  else
    ok "$API_CONTAINER mounts $current_volume at $UPLOADS_MOUNT_POINT"
    uploads_volume="$current_volume"
  fi
elif docker volume inspect "$expected_volume" >/dev/null 2>&1; then
  note "no $API_CONTAINER container; the new one will mount the existing $expected_volume"
  uploads_volume="$expected_volume"
else
  note "no $API_CONTAINER container and no $expected_volume; the first start creates it from the image, owned by the runtime user"
fi
if [ -n "$uploads_volume" ]; then
  runtime_ids="$(image_runtime_ids "taktic-api:$sha")"
  docker image inspect "taktic-api:$sha" >/dev/null 2>&1 \
    || log "taktic-api:$sha not built; checking against the Dockerfile's runtime user $runtime_ids"
  report="$(uploads_ownership_report "$uploads_volume" "$runtime_ids")" || die "could not inspect $uploads_volume"
  foreign="${report%% *}"
  special="${report##* }"
  files="$(helper_run -v "$uploads_volume:/u:ro" "$HELPER_IMAGE" -c 'find /u -type f | wc -l' | tr -d ' ')"
  log "uploads volume holds $files files"
  if [ "$special" -ne 0 ]; then
    bad "$uploads_volume holds $special link(s) or special file(s); neither the ownership fix nor the uploads backup accepts them — inspect by hand"
  elif [ "$foreign" -eq 0 ]; then
    ok "every entry owned by $runtime_ids (the API image's runtime user)"
  elif [ "$allow_uploads_fix" -eq 1 ]; then
    note "$foreign entries not owned by $runtime_ids; deploy-staging.sh --fix-uploads-ownership gives them to it before the API is stopped"
  else
    bad "$foreign entries not owned by $runtime_ids, so the non-root API cannot write them; deploy with --fix-uploads-ownership"
  fi
fi

# --- 9 environment -------------------------------------------------------------
step "9. API environment (names only)"
if container_exists "$API_CONTAINER" && [ -n "$config_json" ]; then
  # Names whose value is non-empty in the running container. awk sees the
  # values; nothing but the names leaves it.
  running="$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" \
    | awk -F= 'NF && length($0) > length($1) + 1 { print $1 }' | sort -u)"
  planned="$(printf '%s' "$config_json" | ops_node compose-security.mjs env-keys api | sort -u)"
  printf '%s\n' "$planned" | grep -qx 'DATABASE_URL' \
    || die "could not list the planned API environment (compose-security.mjs env-keys returned nothing usable)"
  dropped=""
  for name in $running; do
    case "$name" in
      PATH | HOSTNAME | HOME | TERM | NODE_VERSION | YARN_VERSION | CHOKIDAR_USEPOLLING | CHOKIDAR_INTERVAL) continue ;;
    esac
    printf '%s\n' "$planned" | grep -qx "$name" || dropped="$dropped $name"
  done
  if [ -z "$dropped" ]; then
    ok "every variable the running API has a value for is forwarded by docker-compose.prod.yml"
  elif [ "$accept_env_drop" -eq 1 ]; then
    note "no longer forwarded (accepted by --accept-env-drop):$dropped"
  else
    bad "the running API has values for variables docker-compose.prod.yml does not forward:$dropped — add them to the file, or pass --accept-env-drop if they are obsolete"
  fi
else
  note "skipped: no $API_CONTAINER container or no resolved configuration"
fi

# --- 10 backup space -------------------------------------------------------------
step "10. Backup location"
# Read-only: a missing directory is not created here (the deploy creates it).
# Space and permission are judged on the nearest directory that exists.
backup_probe="$BACKUP_ROOT"
while [ ! -d "$backup_probe" ] && [ "$backup_probe" != "/" ]; do
  backup_probe="$(dirname "$backup_probe")"
done
[ "$backup_probe" = "$BACKUP_ROOT" ] || note "$BACKUP_ROOT does not exist yet; the deploy creates it under $backup_probe"
if [ -d "$backup_probe" ] && [ -w "$backup_probe" ]; then
  free_kb="$(df -Pk "$backup_probe" | awk 'NR == 2 { print $4 }')"
  if [ "$pg_ok" -eq 1 ]; then
    need_kb=$(( $(pg_query 'SELECT pg_database_size(current_database())') * 3 / 1024 ))
    [ "$free_kb" -gt "$need_kb" ] && ok "$BACKUP_ROOT: ${free_kb} KiB free (needs > ${need_kb} KiB)" \
      || bad "$BACKUP_ROOT: ${free_kb} KiB free, less than 3x the database size"
  else
    ok "$BACKUP_ROOT writable (${free_kb} KiB free)"
  fi
else
  bad "$backup_probe is not a writable directory (needed for $BACKUP_ROOT)"
fi

step "Preflight: $failures failure(s), $warnings warning(s), $not_run check(s) not run"
[ "$failures" -eq 0 ] || exit 1
if [ "$not_run" -ne 0 ]; then
  warn "INCOMPLETE: build the images (scripts/ops/build-images.sh $sha) and run the preflight again for the checks marked NOT RUN"
  exit 3
fi
