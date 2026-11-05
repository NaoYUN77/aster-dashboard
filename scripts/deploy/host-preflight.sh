#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only readiness, without inspecting container environments or private files.
code=HOST_CHECK_FAILED
trap 'if (( BASH_SUBSHELL == 0 )); then printf "{\"status\":\"host-preflight-failed\",\"code\":\"%s\",\"productionAdmission\":\"not-evaluated\"}\n" "$code" >&2; fi' ERR
require() { code=$1; shift; "$@"; }
require LINUX_AMD64_REQUIRED test "$(uname -sm)" = 'Linux x86_64'
for tool in flock timeout stat sort df getconf; do
  require HOST_TOOL_MISSING command -v "$tool" >/dev/null
done
code=DOCKER_UNAVAILABLE
engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
code=COMPOSE_UNAVAILABLE
compose=$(docker compose version --short 2>/dev/null)
code=DOCKER_TOO_OLD
[[ $(printf '%s\n' 24.0.0 "$engine" | sort -V | head -n 1) == 24.0.0 ]]
code=COMPOSE_TOO_OLD
[[ $(printf '%s\n' 2.24.4 "${compose#v}" | sort -V | head -n 1) == 2.24.4 ]]
code=CPU_INSUFFICIENT
cpu=$(getconf _NPROCESSORS_ONLN)
(( cpu >= 4 ))
code=MEMORY_INSUFFICIENT
memory_bytes=$(( $(getconf _PHYS_PAGES) * $(getconf PAGE_SIZE) ))
# A nominal 4 GB VM reserves some memory for its kernel and hypervisor.
(( memory_bytes >= 3500000000 ))
code=DISK_INSUFFICIENT
available_kib=$(df -Pk / | { read -r header; read -r fs blocks used available rest; printf '%s' "$available"; })
(( available_kib >= 10 * 1024 * 1024 ))
printf '{"status":"host-baseline-ok","cpuCount":%s,"memoryBytes":%s,"rootAvailableKiB":%s,"productionAdmission":"not-evaluated"}\n' "$cpu" "$memory_bytes" "$available_kib"
