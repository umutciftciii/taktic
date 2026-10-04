#!/usr/bin/env bash
# Build the production images for one commit (OPS-004).
#
#   scripts/ops/build-images.sh <commit> [--targets api,web,admin,migrate] [--rebuild]
#
# The build context is `git archive <commit>` — the committed tree and
# nothing else. An untracked .env, a backup, an override file or a local
# node_modules cannot reach the image whatever .dockerignore says, and the
# working tree does not even have to be at that commit: building does not
# touch the checkout, and nothing running changes until a container is
# recreated from the new tag.
#
# Images are tagged taktic-<target>:<full commit sha> and labelled
#   org.opencontainers.image.revision=<sha>
# which the deploy preflight checks before any container is recreated.
#
# web and admin need the public URLs their client code embeds at build time:
#   NEXT_PUBLIC_API_URL  required (the browser calls the API here)
#   NEXT_PUBLIC_WEB_URL  optional (admin links to public provider pages)
# from the shell or the repository's .env. They are public addresses and are
# also recorded as labels, so a later deploy can tell an image built for
# another deployment's URLs.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

commit=""
targets="api,web,admin,migrate"
rebuild=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --targets) targets="${2:?--targets needs a list}"; shift 2 ;;
    --rebuild) rebuild=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "unknown argument: $1" ;;
    *) [ -z "$commit" ] || die "only one commit expected"; commit="$1"; shift ;;
  esac
done
[ -n "$commit" ] || die "usage: build-images.sh <commit> [--targets ...] [--rebuild]"

require_cmd docker git
sha="$(resolve_commit "$commit")"
git -C "$REPO_ROOT" cat-file -e "$sha:Dockerfile" 2>/dev/null \
  || die "commit $sha has no Dockerfile; it predates the production images"

api_url="$(env_or_file NEXT_PUBLIC_API_URL)"
web_url="$(env_or_file NEXT_PUBLIC_WEB_URL)"

work="$(mktemp -d "${TMPDIR:-/tmp}/taktic-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
git -C "$REPO_ROOT" archive --format=tar -o "$work/context.tar" "$sha"
log "context: git archive $sha ($(file_size "$work/context.tar") bytes)"

image_revision() {
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true
}

old_ifs="$IFS"
IFS=','
for target in $targets; do
  IFS="$old_ifs"
  case "$target" in
    api | web | admin | migrate) ;;
    *) die "unknown target: $target" ;;
  esac
  tag="taktic-$target:$sha"
  if [ "$rebuild" -eq 0 ] && [ "$(image_revision "$tag")" = "$sha" ]; then
    case "$target" in
      web | admin)
        built_for="$(docker image inspect -f '{{index .Config.Labels "taktic.next-public-api-url"}}' "$tag")"
        if [ "$built_for" = "$api_url" ]; then log "exists:  $tag"; continue; fi
        log "rebuilding $tag: it was built for NEXT_PUBLIC_API_URL=$built_for"
        ;;
      *) log "exists:  $tag"; continue ;;
    esac
  fi

  step "Building $tag"
  # Only public values are build arguments; see the Dockerfile header.
  set -- --target "$target" -f Dockerfile -t "$tag" \
    --label "org.opencontainers.image.revision=$sha" \
    --label "taktic.target=$target"
  case "$target" in
    web | admin)
      [ -n "$api_url" ] || die "NEXT_PUBLIC_API_URL must be set (shell or .env) to build the $target image"
      set -- "$@" \
        --build-arg "NEXT_PUBLIC_API_URL=$api_url" \
        --build-arg "NEXT_PUBLIC_WEB_URL=$web_url" \
        --label "taktic.next-public-api-url=$api_url" \
        --label "taktic.next-public-web-url=$web_url"
      ;;
  esac
  docker build "$@" - <"$work/context.tar"
  [ "$(image_revision "$tag")" = "$sha" ] || die "built $tag but its revision label is wrong"
  log "built:   $tag"
done
IFS="$old_ifs"

echo "IMAGE_TAG=$sha"
