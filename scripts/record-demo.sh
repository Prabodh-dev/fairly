#!/usr/bin/env bash
# Regenerates docs/demo.cast (an asciinema recording) and docs/demo.svg (the
# animation the README embeds) by running scripts/demo-session.sh against a
# real docker compose stack.
#
# Needs: docker with compose, openssl, curl, asciinema 2.x, and npx (for
# svg-term-cli). Nothing else should be listening on port 8080.
set -euo pipefail

cd "$(dirname "$0")/.."

COLS=100
ROWS=34

# asciinema records the size of the terminal it runs in, so give it a pseudo
# terminal of a fixed size even when this script is started without one.
if [ ! -t 0 ]; then
  exec script -qec "bash $0" /dev/null
fi
stty cols "$COLS" rows "$ROWS"

missing=""
for image in $(docker compose config --images); do
  docker image inspect "$image" >/dev/null 2>&1 || missing=1
done
if [ -n "$missing" ]; then
  docker compose build
fi
docker compose down --volumes >/dev/null 2>&1 || true

asciinema rec \
  --overwrite \
  --idle-time-limit 2 \
  --title "fairly: rate limiting with live policy changes" \
  --command "bash scripts/demo-session.sh" \
  docs/demo.cast

npx --yes svg-term-cli@2.1.1 \
  --in docs/demo.cast \
  --out docs/demo.svg \
  --window \
  --no-cursor \
  --width "$COLS" \
  --height "$ROWS"

echo "wrote docs/demo.cast and docs/demo.svg"
