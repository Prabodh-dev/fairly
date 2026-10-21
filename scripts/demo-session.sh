#!/usr/bin/env bash
# The session that scripts/record-demo.sh records. Each command is typed out
# at human speed and then really run, so everything on screen is genuine output.

TYPE_DELAY=${TYPE_DELAY:-0.02}

typed() {
  local text=$1 i
  printf '\033[1;32m$\033[0m '
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:i:1}"
    sleep "$TYPE_DELAY"
  done
  sleep 0.5
  printf '\n'
}

say() {
  printf '\033[2m# %s\033[0m\n' "$1"
  sleep 1.2
}

run() {
  typed "$1"
  eval "${2:-$1}"
  sleep "${3:-1.5}"
}

fresh() {
  sleep 1.5
  printf '\033[2J\033[H'
}

cd "$(dirname "$0")/.." || exit 1

say "Start fairly and its Redis"
run 'export FAIRLY_ADMIN_TOKEN=$(openssl rand -hex 16)'
run 'docker compose up -d --wait'
run "docker compose ps --format 'table {{.Service}}\t{{.Status}}'"

fresh
say "The /login policy allows 5 requests per 5 minutes per key"
run "check() { curl -si -X POST localhost:8080/v1/check -H content-type:application/json -d '{\"key\":\"alice\",\"route\":\"/login\"}' | grep -iE '^(HTTP|x-ratel|retry)'; }" '' 0.5
run 'for i in 1 2 3 4 5 6; do check; done' '' 3

fresh
say "Raise the limit to 10 while the service keeps running"
run "curl -s -X PUT localhost:8080/v1/admin/policies/login \\
  -H \"x-admin-token: \$FAIRLY_ADMIN_TOKEN\" -H content-type:application/json \\
  -d '{\"route\":\"/login\",\"algorithm\":\"sliding-window-log\",\"limit\":10,\"windowSeconds\":300}'" '' 1
echo
run 'check' '' 2
run "curl -s localhost:8080/metrics | grep '^fairly_decisions_total'" '' 3
run 'docker compose down --volumes' '' 1
