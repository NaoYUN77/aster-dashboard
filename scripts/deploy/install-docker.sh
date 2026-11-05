#!/usr/bin/env bash
set -Eeuo pipefail

# Run as root on Ubuntu. Use the distribution's signed package repository;
# neither remote install scripts nor third-party registry mirrors are needed.
code=INSTALL_FAILED
trap 'if (( BASH_SUBSHELL == 0 )); then printf "{\"status\":\"docker-install-failed\",\"code\":\"%s\"}\n" "$code" >&2; fi' ERR
if [[ $EUID != 0 ]]; then code=ROOT_REQUIRED; false; fi
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then code=UBUNTU_REQUIRED; false; fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  code=APT_UPDATE_FAILED
  apt-get update -qq
  code=APT_INSTALL_FAILED
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io docker-compose-v2
fi
code=DOCKER_START_FAILED
systemctl enable --now docker
code=DOCKER_VERSION_UNSUPPORTED
engine=$(docker version --format '{{.Server.Version}}')
compose=$(docker compose version --short)
[[ $(printf '%s\n' 24.0.0 "$engine" | sort -V | head -n 1) == 24.0.0 ]]
[[ $(printf '%s\n' 2.24.4 "${compose#v}" | sort -V | head -n 1) == 2.24.4 ]]
printf '{"status":"docker-installed","engine":"%s","compose":"%s"}\n' "$engine" "$compose"
