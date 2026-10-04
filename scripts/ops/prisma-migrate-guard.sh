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
#
# Everything else is refused before Prisma starts: `migrate dev`, `migrate
# reset`, `db push`, `migrate resolve`, and any form that needs a shadow
# database. `migrate diff --from-migrations` would create one, which is why
# the drift check compares the live database with the schema file instead.
set -eu

PRISMA=/app/node_modules/.bin/prisma
SCHEMA=/app/prisma/schema.prisma

die() {
  echo "taktic-migrate: $*" >&2
  exit 64
}

[ "$#" -eq 1 ] || die "exactly one command expected (status | deploy | drift | migrations); got $#"

case "$1" in
  migrations)
    for dir in /app/prisma/migrations/*/; do
      dir="${dir%/}"
      echo "${dir##*/}"
    done
    exit 0
    ;;
  status | deploy | drift) ;;
  *) die "refused: '$1' is not one of status | deploy | drift | migrations" ;;
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
