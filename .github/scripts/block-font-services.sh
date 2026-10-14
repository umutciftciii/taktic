#!/usr/bin/env bash
# CI-FONTS-001: make the font services unreachable from this runner.
#
# The web and admin builds must not depend on a font fetched over the network
# — next/font/google did exactly that, and a runner that could not reach Google
# could not build the site. Every host below is pointed at an unroutable
# address in /etc/hosts, so a build step that still reaches for one fails
# here, in CI, instead of on the next runner whose network says no.
#
# The step then proves the block holds: each name must resolve to the dead
# address and an HTTPS request to it must fail. Docker builds do not read this
# file; scripts/ops/build-images.sh blocks the same hosts with --add-host.
set -euo pipefail

hosts=(fonts.googleapis.com fonts.gstatic.com use.typekit.net p.typekit.net fonts.bunny.net)

for host in "${hosts[@]}"; do
  printf '0.0.0.0 %s\n:: %s\n' "$host" "$host" | sudo tee -a /etc/hosts >/dev/null
done

for host in "${hosts[@]}"; do
  resolved="$(getent ahosts "$host" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
  case "$resolved" in
    "0.0.0.0 :: " | ":: 0.0.0.0 " | "0.0.0.0 " | ":: ") ;;
    *) echo "::error::$host still resolves to: $resolved"; exit 1 ;;
  esac
  if curl -sS --max-time 5 -o /dev/null "https://$host/" 2>/dev/null; then
    echo "::error::$host is still reachable"
    exit 1
  fi
  echo "blocked: $host -> $resolved"
done
