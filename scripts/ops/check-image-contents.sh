#!/usr/bin/env bash
# Inspect built production images for things that must never be in them.
#
#   scripts/ops/check-image-contents.sh <tag>      e.g. the commit sha
#
# Checks taktic-{api,web,admin,migrate}:<tag>:
#
#   all      no .env / .env.* file, no .git directory, no backup dump, no
#            docker-compose override anywhere in the filesystem; runs as the
#            unprivileged `node` user; code is not writable by that user
#   api      compiled dist/main.js, no TypeScript sources, no source maps, no
#            test runner or TS compiler in node_modules, Prisma engine
#            present for the image's platform, uploads dir owned by node
#   web      a next build output (.next/BUILD_ID), next.config.mjs (never .ts:
#   admin    `next start` would try to install TypeScript at runtime), no
#            .next/cache baked in, no TypeScript or test runner installed
#   migrate  the guard entrypoint, migrations present, and the guard refusing
#            `migrate dev` / `reset` / `db push`
#
# Exit 0 when every check passes. Used by CI and safe to run on any host.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

tag="${1:?usage: check-image-contents.sh <tag>}"
failures=0
ok() { printf '%s  ok   %s\n' "$(_ts)" "$*" >&2; }
bad() { printf '%s  FAIL %s\n' "$(_ts)" "$*" >&2; failures=$((failures + 1)); }

# Run a shell snippet inside an image as its own user, without its entrypoint
# and without network.
in_image() {
  docker run --rm --network none --entrypoint sh "$1" -c "$2"
}

for target in api web admin migrate; do
  image="taktic-$target:$tag"
  step "$image"
  docker image inspect "$image" >/dev/null 2>&1 || { bad "$image not found"; continue; }

  user="$(docker image inspect -f '{{.Config.User}}' "$image")"
  [ "$user" = "node" ] && ok "runs as user node" || bad "runs as '$user', expected node"

  leaks="$(in_image "$image" 'find / -xdev \( -name ".env" -o -name ".env.*" -o -name ".git" -o -name "*.dump" -o -name "docker-compose.override.yml" -o -name "id_rsa*" \) 2>/dev/null | grep -v "^/proc" | head -n 20' || true)"
  [ -z "$leaks" ] && ok "no .env, .git, dump, override or key file" || bad "forbidden files present: $(echo "$leaks" | tr '\n' ' ')"

  case "$target" in
    api)
      in_image "$image" 'test -f dist/main.js' && ok "dist/main.js present" || bad "dist/main.js missing"
      stray="$(in_image "$image" 'find dist -name "*.map" -o -name "*.ts" | head -n 5; ls -d src 2>/dev/null; true')"
      [ -z "$stray" ] && ok "no sources or source maps" || bad "sources or maps in image: $(echo "$stray" | tr '\n' ' ')"
      in_image "$image" 'touch dist/.write-test 2>/dev/null' && bad "code directory is writable by the process" || ok "code is read-only to the process"
      in_image "$image" 'test "$(stat -c %U uploads)" = node' && ok "uploads/ owned by node" || bad "uploads/ not owned by node"
      in_image "$image" 'ls node_modules/.pnpm | grep -q "^@prisma+client@" && find node_modules/.pnpm -path "*/.prisma/client/libquery_engine-*.so.node" | grep -q .' \
        && ok "generated Prisma client with its engine" || bad "generated Prisma client or engine missing"
      ;;
    web | admin)
      in_image "$image" 'test -f .next/BUILD_ID' && ok ".next build output present" || bad ".next/BUILD_ID missing"
      in_image "$image" 'test -f next.config.mjs && ! test -e next.config.ts' && ok "next.config.mjs (compiled), no next.config.ts" \
        || bad "expected next.config.mjs and no next.config.ts"
      cached="$(in_image "$image" 'find .next/cache -mindepth 1 | head -n 3; true')"
      [ -z "$cached" ] && ok "no build cache baked in" || bad ".next/cache has content"
      in_image "$image" 'touch .next/.write-test 2>/dev/null' && bad ".next is writable by the process" || ok "build output is read-only to the process"
      ;;
    migrate)
      in_image "$image" 'test -x /usr/local/bin/taktic-migrate' && ok "guard entrypoint present" || bad "guard entrypoint missing"
      count="$(docker run --rm --network none "$image" migrations | grep -c . || true)"
      [ "$count" -gt 0 ] && ok "$count migrations" || bad "no migrations in image"
      for refused in dev reset "db push" resolve; do
        if docker run --rm --network none -e DATABASE_URL=postgresql://x@127.0.0.1:1/x "$image" "$refused" >/dev/null 2>&1; then
          bad "guard accepted '$refused'"
        fi
      done
      ok "guard refuses dev, reset, db push and resolve"
      ;;
  esac

  case "$target" in
    api | web | admin)
      # The app's own devDependencies (read from the package.json in the
      # image) must not be installed, and neither may a compiler or test
      # runner arriving any other way. Transitive runtime @types packages
      # (cron -> @types/luxon) are dependencies, not dev tooling.
      dev_tools="$(in_image "$image" '
        node -e "for (const n of Object.keys(require(\"./package.json\").devDependencies || {})) console.log(n)" |
          while read -r name; do [ -e "node_modules/$name" ] && echo "$name"; done
        ls node_modules/.pnpm | grep -E "^(typescript|vitest|@vitest\+|ts-node-dev|@swc\+core|supertest|@nestjs\+testing)@"
        true' || true)"
      [ -z "$dev_tools" ] && ok "no devDependencies, compiler or test runner installed" || bad "development packages present: $(echo "$dev_tools" | tr '\n' ' ')"
      ;;
  esac
done

step "Image contents: $failures failure(s)"
[ "$failures" -eq 0 ]
