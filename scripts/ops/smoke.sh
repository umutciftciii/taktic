#!/usr/bin/env bash
# Post-deploy smoke of the production stack (read-only).
#
#   scripts/ops/smoke.sh [--sha <commit>]
#
# Over the loopback ports the host publishes (API_PORT / WEB_PORT /
# ADMIN_PORT from the shell or .env, defaults 3001 / 3000 / 3002):
#
#   api    GET /health answers {"status":"ok"}; GET /uploads/<missing> is a
#          404, not an error (the static upload root is mounted and readable)
#   web    GET /robots.txt answers 200
#   admin  GET /login answers 200
#   all    no X-Powered-By; X-Content-Type-Options, X-Frame-Options,
#          Referrer-Policy and Strict-Transport-Security present — the
#          security headers each app already sets, unchanged by the runtime
#
# And on the containers: each runs taktic-<service>:<sha> (with --sha) as uid
# 1000, with no host bind mount, published on loopback only.

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha="$(resolve_commit "${2:?--sha needs a commit}")"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
require_cmd curl docker

api_port="$(env_or_file API_PORT)"
web_port="$(env_or_file WEB_PORT)"
admin_port="$(env_or_file ADMIN_PORT)"
api_port="${api_port:-3001}"
web_port="${web_port:-3000}"
admin_port="${admin_port:-3002}"

failures=0
ok() { printf '%s  ok   %s\n' "$(_ts)" "$*" >&2; }
bad() { printf '%s  FAIL %s\n' "$(_ts)" "$*" >&2; failures=$((failures + 1)); }

# GET a URL; prints "<status>" and leaves headers in $headers_file.
headers_file="$(mktemp "${TMPDIR:-/tmp}/taktic-smoke.XXXXXX")"
body_file="$(mktemp "${TMPDIR:-/tmp}/taktic-smoke.XXXXXX")"
trap 'rm -f "$headers_file" "$body_file"' EXIT
fetch() {
  curl -sS -o "$body_file" -D "$headers_file" -w '%{http_code}' --max-time 20 "$1" || echo 000
}
header_present() { grep -qi "^$1:" "$headers_file"; }

check_headers() {
  local who="$1" name
  if header_present 'x-powered-by'; then bad "$who sends X-Powered-By"; else ok "$who: no X-Powered-By"; fi
  for name in x-content-type-options x-frame-options referrer-policy strict-transport-security; do
    header_present "$name" || bad "$who is missing $name"
  done
}

step "API http://127.0.0.1:$api_port"
code="$(fetch "http://127.0.0.1:$api_port/health")"
if [ "$code" = 200 ] && grep -q '"status":"ok"' "$body_file"; then ok "/health 200 ok"; else bad "/health answered $code"; fi
check_headers api
code="$(fetch "http://127.0.0.1:$api_port/uploads/category-images/smoke-does-not-exist.png")"
[ "$code" = 404 ] && ok "/uploads/<missing> 404" || bad "/uploads/<missing> answered $code (expected 404)"

step "web http://127.0.0.1:$web_port"
code="$(fetch "http://127.0.0.1:$web_port/robots.txt")"
[ "$code" = 200 ] && ok "/robots.txt 200" || bad "/robots.txt answered $code"
check_headers web

step "admin http://127.0.0.1:$admin_port"
code="$(fetch "http://127.0.0.1:$admin_port/login")"
[ "$code" = 200 ] && ok "/login 200" || bad "/login answered $code"
check_headers admin

step "Containers"
for pair in "api:$API_CONTAINER" "web:$WEB_CONTAINER" "admin:$ADMIN_CONTAINER"; do
  service="${pair%%:*}"
  name="${pair#*:}"
  if ! container_running "$name"; then
    bad "$name is not running"
    continue
  fi
  image="$(docker container inspect -f '{{.Config.Image}}' "$name")"
  if [ -n "$sha" ]; then
    [ "$image" = "taktic-$service:$sha" ] && ok "$name runs $image" || bad "$name runs $image, expected taktic-$service:$sha"
  else
    log "$name runs $image"
  fi
  uid="$(docker exec "$name" id -u)"
  [ "$uid" = 1000 ] && ok "$name runs as uid 1000" || bad "$name runs as uid $uid"
  binds="$(docker container inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}' "$name")"
  [ -z "$binds" ] && ok "$name has no bind mount" || bad "$name bind-mounts $binds"
  ips="$(docker container inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}} {{end}}{{end}}' "$name")"
  wide=""
  for ip in $ips; do case "$ip" in 127.0.0.1 | ::1) ;; *) wide="$wide $ip" ;; esac; done
  [ -z "$wide" ] && ok "$name published on loopback only ($ips)" || bad "$name published on$wide"
done

step "Smoke: $failures failure(s)"
[ "$failures" -eq 0 ]
