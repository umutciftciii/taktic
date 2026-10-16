#!/bin/sh
# Entrypoint of the `migrate` image (Dockerfile, target `migrate`).
#
# The only Prisma operations a deployed database is allowed to see, each one
# a fixed command line with no pass-through arguments:
#
#   status      prisma migrate status            read-only; exit 1 when the
#                                                database is not up to date
#   deploy      prisma migrate deploy            applies pending migrations,
#                                                never generates or resets
#   drift       prisma migrate diff --from-url <DATABASE_URL>
#                 --to-schema-datamodel prisma/schema.prisma --exit-code
#                                                read-only introspection;
#                                                exit 2 when the live schema
#                                                differs from this commit's
#   migrations  the migration directory names this image carries, one per line
#   resolve-rolled-back <migration_name>
#               prisma migrate resolve --rolled-back <migration_name>
#               — the P3009 recovery, and only on staging. Refused unless
#               APP_ENVIRONMENT is exactly `staging`, the name is a migration
#               this image carries, and TAKTIC_RESOLVE_CONFIRM equals it. The
#               evidence that the failed migration left nothing behind is
#               gathered by scripts/ops/migration-recover.sh, which is the only
#               caller and sets the confirmation after its checks; Prisma itself
#               refuses a migration that is not in a failed state (P3012).
#
# Everything else is refused before Prisma starts: `migrate dev`, `migrate
# reset`, `db push`, `migrate resolve --applied`, any other form of `migrate
# resolve`, and any form that needs a shadow
# database. `migrate diff --from-migrations` would create one, which is why
# the drift check compares the live database with the schema file instead.
set -eu

PRISMA=/app/node_modules/.bin/prisma
SCHEMA=/app/prisma/schema.prisma

die() {
  echo "taktic-migrate: $*" >&2
  exit 64
}

COMMANDS="status | deploy | drift | migrations | resolve-rolled-back <migration_name>"
[ "$#" -ge 1 ] || die "a command is expected ($COMMANDS)"

if [ "$1" = "resolve-rolled-back" ]; then
  [ "$#" -eq 2 ] || die "resolve-rolled-back takes exactly one migration name; got $(($# - 1)) argument(s)"
  name="$2"
  printf '%s' "$name" | grep -Eq '^[0-9]{14}_[a-z0-9_]+$' || die "refused: '$name' is not a migration directory name"
  [ -f "/app/prisma/migrations/$name/migration.sql" ] || die "refused: this image carries no migration $name"
  [ "${APP_ENVIRONMENT:-}" = "staging" ] \
    || die "refused: resolve-rolled-back runs only where APP_ENVIRONMENT=staging (got '${APP_ENVIRONMENT:-unset}'); production recovers by restore or fix-forward"
  [ "${TAKTIC_RESOLVE_CONFIRM:-}" = "$name" ] \
    || die "refused: TAKTIC_RESOLVE_CONFIRM does not name $name; run scripts/ops/migration-recover.sh, which checks the database first"
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
  echo "taktic-migrate: marking $name as rolled back (APP_ENVIRONMENT=staging, confirmed)" >&2
  exec "$PRISMA" migrate resolve --rolled-back "$name" --schema "$SCHEMA"
fi

[ "$#" -eq 1 ] || die "exactly one command expected ($COMMANDS); got $#"

case "$1" in
  migrations)
    for dir in /app/prisma/migrations/*/; do
      dir="${dir%/}"
      echo "${dir##*/}"
    done
    exit 0
    ;;
  status | deploy | drift) ;;
  *) die "refused: '$1' is not one of $COMMANDS" ;;
esac

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"

case "$1" in
  status) exec "$PRISMA" migrate status --schema "$SCHEMA" ;;
  deploy) exec "$PRISMA" migrate deploy --schema "$SCHEMA" ;;
  drift)
    exec "$PRISMA" migrate diff \
      --from-url "$DATABASE_URL" \
      --to-schema-datamodel "$SCHEMA" \
      --exit-code
    ;;
esac
