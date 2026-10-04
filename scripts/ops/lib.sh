# shellcheck shell=bash
# Variables defined here are used by the scripts that source this file.
# shellcheck disable=SC2034
# Shared helpers for scripts/ops/*.sh. Sourced, never executed.
#
# Written for the bash that ships with macOS (3.2): no associative arrays, no
# mapfile, no ${var,,}, and no "${array[@]}" expansion of a possibly-empty
# array under `set -u`.
#
# Nothing here ever prints a secret. Values read from .env are limited to the
# few public or structural keys named at the call site (env_file_value), and
# database credentials stay inside the postgres container, which the scripts
# reach with `docker exec` over its local socket.

set -Eeuo pipefail
umask 077

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The host's checkout. Normally the directory these scripts live in; a deploy
# runs the *target* commit's copy of scripts/ops from a staging directory
# (deploy-staging.sh) and points back at the checkout through
# TAKTIC_REPO_ROOT, and at the target's compose file through
# TAKTIC_PROD_COMPOSE_FILE.
REPO_ROOT="${TAKTIC_REPO_ROOT:-$(cd "$OPS_DIR/../.." && pwd)}"
PROD_COMPOSE_FILE="${TAKTIC_PROD_COMPOSE_FILE:-$REPO_ROOT/docker-compose.prod.yml}"

# Container names follow docker-compose.prod.yml's TAKTIC_CONTAINER_PREFIX.
CONTAINER_PREFIX="${TAKTIC_CONTAINER_PREFIX:-taktic}"
POSTGRES_CONTAINER="${TAKTIC_POSTGRES_CONTAINER:-$CONTAINER_PREFIX-postgres}"
API_CONTAINER="${TAKTIC_API_CONTAINER:-$CONTAINER_PREFIX-api}"
WEB_CONTAINER="${TAKTIC_WEB_CONTAINER:-$CONTAINER_PREFIX-web}"
ADMIN_CONTAINER="${TAKTIC_ADMIN_CONTAINER:-$CONTAINER_PREFIX-admin}"
UPLOADS_MOUNT_POINT=/app/apps/api/uploads
# Already on every host that runs the stack, so the helper containers below
# never pull anything new. Overridable for a host on a different tag.
HELPER_IMAGE="${TAKTIC_HELPER_IMAGE:-postgres:16.6-alpine}"
BACKUP_ROOT="${TAKTIC_BACKUP_DIR:-$HOME/Backups/taktic}"

_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s  %s\n' "$(_ts)" "$*" >&2; }
step() { printf '\n%s  ==> %s\n' "$(_ts)" "$*" >&2; }
warn() { printf '%s  WARN %s\n' "$(_ts)" "$*" >&2; }
die() {
  printf '%s  FAIL %s\n' "$(_ts)" "$*" >&2
  exit 1
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

# sha256 of a file, hex only. macOS has shasum, Linux has sha256sum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_size() {
  wc -c <"$1" | tr -d ' '
}

# The value of one KEY from the repository's .env, for structural or public
# keys only (COMPOSE_PROJECT_NAME, NEXT_PUBLIC_*). Surrounding quotes are
# stripped; nothing is evaluated.
env_file_value() {
  local key="$1" file="$REPO_ROOT/.env" line
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# KEY from the environment, else from .env.
env_or_file() {
  local key="$1" value
  eval "value=\"\${$key:-}\""
  if [ -z "$value" ]; then
    value="$(env_file_value "$key")"
  fi
  printf '%s' "$value"
}

# The prod compose project name, required and never inferred from the
# directory: the wrong name silently creates fresh, empty volumes.
require_project_name() {
  COMPOSE_PROJECT_NAME="$(env_or_file COMPOSE_PROJECT_NAME)"
  [ -n "$COMPOSE_PROJECT_NAME" ] || die "COMPOSE_PROJECT_NAME is not set (shell or .env). It must name the project that owns the existing volumes."
  export COMPOSE_PROJECT_NAME
}

# docker compose against the prod file. TAKTIC_IMAGE_TAG must be exported by
# the caller before any command that resolves an image.
# --project-directory keeps .env (and the project's identity) anchored to the
# checkout even when the compose file itself comes from a staging directory.
prod_compose() {
  docker compose --project-directory "$REPO_ROOT" -f "$PROD_COMPOSE_FILE" "$@"
}

# Full 40-character commit for a revision, or die.
resolve_commit() {
  local sha
  sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${1}^{commit}")" || die "not a commit in this repository: $1"
  printf '%s' "$sha"
}

container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

container_running() {
  [ "$(docker container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

container_health() {
  docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing
}

container_id() { docker container inspect -f '{{.Id}}' "$1"; }

container_label() {
  docker container inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null || true
}

# Wait until a container reports healthy (or, without a healthcheck, running).
wait_healthy() {
  local name="$1" timeout="${2:-180}" waited=0 status
  while [ "$waited" -lt "$timeout" ]; do
    status="$(container_health "$name")"
    case "$status" in
      healthy) return 0 ;;
      none) container_running "$name" && return 0 ;;
      unhealthy) die "$name reported unhealthy; see: docker logs --tail 100 $name" ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  die "$name did not become healthy within ${timeout}s (last status: $status)"
}

# Database name and user as the postgres container declares them. Never the
# password: pg_dump and psql run inside the container over the local socket.
pg_container_db() { docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_DB; }
pg_container_user() { docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_USER; }

# psql inside the postgres container, unaligned, tuples only, stop on error.
pg_query() {
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -X -q -tA \
    -U "$(pg_container_user)" -d "$(pg_container_db)" -c "$1"
}

require_postgres_ready() {
  container_running "$POSTGRES_CONTAINER" || die "$POSTGRES_CONTAINER is not running"
  docker exec "$POSTGRES_CONTAINER" pg_isready -q -U "$(pg_container_user)" -d "$(pg_container_db)" \
    || die "$POSTGRES_CONTAINER is running but not accepting connections"
}

# Applied (finished, not rolled back) migrations in the live database.
applied_migration_count() {
  pg_query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
}

# Migration names an image carries (its prisma/migrations directory) — read
# from the image itself, no database involved.
image_migrations() {
  docker run --rm --network none "$1" migrations | sort
}

# Migration names the live database has applied.
applied_migrations() {
  pg_query 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' | sort
}

# Rows of _prisma_migrations that started and neither finished nor were
# rolled back: a migration that failed half-way. `migrate deploy` refuses to
# continue past one, and so do these scripts.
unfinished_migrations() {
  pg_query 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY migration_name'
}

# The named volume mounted at the API's upload root, read from the API
# container itself — the one source that cannot name the wrong volume.
api_uploads_volume() {
  docker container inspect -f "{{range .Mounts}}{{if eq .Destination \"$UPLOADS_MOUNT_POINT\"}}{{.Name}}{{end}}{{end}}" "$API_CONTAINER" 2>/dev/null || true
}

# A throwaway container with no network and no capabilities beyond reading
# files, for inspecting or archiving a volume. Extra `docker run` flags
# (mounts) come first, then the shell script to run.
helper_run() {
  docker run --rm -i --network none --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges --entrypoint sh "$@"
}

# Safety check over a busybox `tar -tzv` listing, whose lines are
# "<mode> <owner>/<group> <size> <date> <time> <name...>". The name is
# everything after the fifth field, spaces included. Exits non-zero, printing
# each offending entry, on: an entry that is not a file or directory (links,
# devices), an absolute path, or any '..' component. Used on the host and,
# through the environment, inside helper containers.
# shellcheck disable=SC2016
ARCHIVE_LISTING_AWK='
{
  type = substr($1, 1, 1)
  name = $0
  for (i = 0; i < 5; i++) sub(/^[ \t]*[^ \t]+/, "", name)
  sub(/^[ \t]+/, "", name)
  if (type != "-" && type != "d") { print "entry type " type ": " name; bad = 1 }
  if (name ~ /^\//) { print "absolute path: " name; bad = 1 }
  if (name ~ /(^|\/)\.\.(\/|$)/) { print "parent reference: " name; bad = 1 }
}
END { exit bad }
'

# Run one of the Node tools in scripts/ops (by file name) with the host's
# Node when it is 18 or newer, else in a throwaway node container with no
# network. stdin is passed through either way.
NODE_TOOL_IMAGE="${TAKTIC_NODE_TOOL_IMAGE:-node:22.23.2-alpine}"
ops_node() {
  local tool="$1"
  shift
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
    node "$OPS_DIR/$tool" "$@"
  else
    docker run --rm -i --network none -v "$OPS_DIR:/ops:ro" "$NODE_TOOL_IMAGE" node "/ops/$tool" "$@"
  fi
}

# Run a mutating command, or only print it under DRY_RUN=1.
DRY_RUN="${DRY_RUN:-0}"
run_mut() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s  [dry-run] %s\n' "$(_ts)" "$*" >&2
    return 0
  fi
  "$@"
}
