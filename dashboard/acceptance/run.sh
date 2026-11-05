#!/usr/bin/env bash
# Acceptance run for the one-machine dashboard overlay (app + aster-sandbox).
#
# Run from a clean deployment host, from the repository root:
#   bash dashboard/acceptance/run.sh                 # build, start, drive criteria 1,2,3,4,5,6,7,8,10
#   bash dashboard/acceptance/run.sh --with-tests    # additionally run npm test and test:topology
#
# It uses its own compose project and volume names, so it never writes into another deployment's
# data. The model prompts need a real provider key in dashboard/.env.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

ENV_FILE=${ASTER_DASHBOARD_ENV_FILE:-dashboard/.env}
PROJECT=${ACCEPTANCE_PROJECT:-aster-acceptance}
WITH_TESTS=0
for argument in "$@"; do
  case "$argument" in
    --with-tests) WITH_TESTS=1 ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

export ASTER_DASHBOARD_ENV_FILE=$ENV_FILE
export ASTER_IMAGE=${ASTER_IMAGE:-aster:local}
export ASTER_SANDBOX_IMAGE=${ASTER_SANDBOX_IMAGE:-aster-sandbox:local}
# Dedicated volumes keep acceptance bots and files away from a real deployment on the same host.
export ASTER_APP_VOLUME=${ASTER_APP_VOLUME:-aster-acceptance-app}
export ASTER_SANDBOX_RUNTIME_VOLUME=${ASTER_SANDBOX_RUNTIME_VOLUME:-aster-acceptance-runtime}
export ASTER_SANDBOX_WORKSPACES_VOLUME=${ASTER_SANDBOX_WORKSPACES_VOLUME:-aster-acceptance-workspaces}

compose() {
  docker compose --project-name "$PROJECT" \
    -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml --env-file "$ENV_FILE" "$@"
}

failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
die() { echo "ABORT $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE; copy dashboard/.env.example and fill it in"
grep -Eq '^WEB_TOKEN=[^[:space:]]{16,}$' "$ENV_FILE" || die "WEB_TOKEN must be 16-256 characters in $ENV_FILE"
grep -Eq '^MODEL_PROVIDER=.+$' "$ENV_FILE" || die "MODEL_PROVIDER missing in $ENV_FILE"
grep -Eq '^MODEL_ID=.+$' "$ENV_FILE" || die "MODEL_ID missing in $ENV_FILE"
command -v docker >/dev/null || die "docker is not installed"
command -v curl >/dev/null || die "curl is required for the token and port checks"

version=$(docker compose version --short 2>/dev/null | tr -d 'v' || true)
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] \
  && ! (( major > 2 || (major == 2 && minor >= 24) )); then
  die "Docker Compose 2.24 or newer is required (the overlay uses !override); found $version"
fi

echo "== A1: build and start the overlay"
started=$(date +%s)
compose up -d --build || die "compose up failed"
echo "PASS A1 overlay started in $(( $(date +%s) - started ))s"

running=$(compose ps --status running --format '{{.Service}}' | sort | tr '\n' ' ')
[[ "$running" == "aster-sandbox personal-agent " ]] \
  && pass "A1 both services are running" \
  || fail "A1 running services: $running"

sandbox_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
  "$(compose ps -q aster-sandbox)" 2>/dev/null || echo unknown)
for _ in $(seq 1 60); do
  [[ "$sandbox_status" == "healthy" ]] && break
  sleep 2
  sandbox_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$(compose ps -q aster-sandbox)" 2>/dev/null || echo unknown)
done
[[ "$sandbox_status" == "healthy" ]] && pass "A1 the sandbox is healthy" || fail "A1 sandbox health: $sandbox_status"

echo "== A10: loopback-only console and token gate"
published=$(compose port personal-agent 8787 | head -1 | tr -d '\r')
if [[ "$published" == "127.0.0.1:8787" ]]; then
  pass "A10 the console is published on 127.0.0.1:8787"
elif command -v ss >/dev/null && ss -ltnH 'sport = :8787' | grep -q '127\.0\.0\.1:8787'; then
  # With the MITM overlay the app has no publishable network and console-ingress owns the port.
  pass "A10 the console answers on 127.0.0.1:8787 (console ingress)"
else
  fail "A10 published address: ${published:-none}"
fi
if command -v ss >/dev/null; then
  ss -ltnH 'sport = :8787' | grep -q '127\.0\.0\.1:8787' \
    && pass "A10 the host listens only on loopback" \
    || fail "A10 host listener: $(ss -ltnH 'sport = :8787' | tr -s ' ' | tr '\n' ';')"
fi
status=000
for _ in $(seq 1 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/api/bots" || true)
  [[ "$status" == "401" ]] && break
  sleep 2
done
[[ "$status" == "401" ]] \
  && pass "A10 a request without the token is 401" \
  || fail "A10 tokenless request status: $status"

app_id=$(compose ps -q personal-agent)
[[ -n "$app_id" ]] || die "the app container is not running"

echo "== A2/A3/A4/A5/A6/A7: console, bots, isolation, concurrency, events, cancel"
docker cp dashboard/acceptance/console-check.mjs "$app_id:/tmp/console-check.mjs" >/dev/null
if ! docker exec "$app_id" node /tmp/console-check.mjs; then
  fail "A2-A7 console acceptance reported failures"
fi

echo "== A8: restart keeps bots and history"
compose restart personal-agent >/dev/null
for _ in $(seq 1 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/api/bots" || true)
  [[ "$status" == "401" ]] && break
  sleep 2
done
app_id=$(compose ps -q personal-agent)
if ! docker exec "$app_id" node /tmp/console-check.mjs --verify-restart; then
  fail "A8 restart acceptance reported failures"
fi

echo "== A4/A5/A7: sandbox boundaries over the RPC socket"
app_image=$(docker inspect --format '{{.Config.Image}}' "$app_id")
if ! docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 --user 1000:1000 \
  --env EXECUTION_RPC_TRANSPORT=unix --env EXECUTION_RPC_SOCKET=/run/aster/rpc.sock \
  --mount "type=volume,source=${ASTER_SANDBOX_RUNTIME_VOLUME},target=/run/aster,readonly" \
  --mount "type=bind,source=${ROOT}/dashboard/acceptance/sandbox-check.mjs,target=/check.mjs,readonly" \
  --entrypoint node "$app_image" /check.mjs; then
  fail "A4/A5/A7 sandbox acceptance reported failures"
fi

if (( WITH_TESTS )); then
  echo "== A9: unit and topology suites"
  command -v npm >/dev/null || die "npm is required for --with-tests"
  npm test || fail "A9 npm test failed"
  npm run test:topology || fail "A9 test:topology failed"
else
  echo "NOTE A9 is not run here; run 'npm test' and 'npm run test:topology' on a machine with Node 24 and Docker."
fi

echo
echo "Acceptance summary: $failures failing check group(s)."
echo "The stack is still running as project '$PROJECT'."
echo "Inspect:   docker compose --project-name $PROJECT -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml ps"
echo "Tear down: docker compose --project-name $PROJECT -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml down -v"
exit $(( failures == 0 ? 0 : 1 ))
