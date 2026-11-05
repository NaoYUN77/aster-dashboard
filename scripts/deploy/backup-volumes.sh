#!/usr/bin/env bash
set -Eeuo pipefail

# Writers must already be stopped. This command never stops services, restores
# data or changes a production Compose project. All daemon output stays private.
code=ARGUMENTS_INVALID
container=
snapshot=
finished=0
cleanup() {
  local result=$?
  if [[ -n $container ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if (( result != 0 )); then
    printf '{"status":"backup-failed","code":"%s","productionAdmission":"not-evaluated"}\n' "$code" >&2
  elif (( finished == 0 )); then
    printf '{"status":"backup-failed","code":"INTERRUPTED","productionAdmission":"not-evaluated"}\n' >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
fail() { code=$1; exit 1; }
image= app= backup_root=
while (( $# )); do
  (( $# >= 2 )) || fail ARGUMENTS_INVALID
  case $1 in
    --image) [[ -z $image ]] || fail ARGUMENTS_INVALID; image=$2 ;;
    --app-volume) [[ -z $app ]] || fail ARGUMENTS_INVALID; app=$2 ;;
    --backup-root) [[ -z $backup_root ]] || fail ARGUMENTS_INVALID; backup_root=$2 ;;
    *) fail ARGUMENTS_INVALID ;;
  esac
  shift 2
done
[[ $image =~ ^sha256:[0-9a-f]{64}$ || $image =~ ^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] || fail IMAGE_MUST_BE_IMMUTABLE
[[ $app =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || fail VOLUME_NAMES_INVALID
[[ $backup_root == /* && -d $backup_root && ! -L $backup_root ]] || fail BACKUP_ROOT_INVALID
[[ $(stat -c %u "$backup_root") == "$EUID" ]] || fail BACKUP_ROOT_OWNER
permissions=$(stat -c %a "$backup_root")
(( (8#$permissions & 077) == 0 )) || fail BACKUP_ROOT_PERMISSIONS
# Serialize this tool's backups. Other Docker administrators must also keep
# these volumes quiescent; the daemon offers no transaction over these checks.
code=BACKUP_LOCKED
exec 9>"$backup_root/.backup.lock"
flock -n 9 || fail BACKUP_LOCKED
code=IMAGE_UNAVAILABLE
docker image inspect "$image" >/dev/null 2>&1 || fail IMAGE_UNAVAILABLE
for volume in "$app"; do
  docker volume inspect "$volume" >/dev/null 2>&1 || fail VOLUME_MISSING
  driver=$(docker volume inspect --format '{{.Driver}}' "$volume" 2>/dev/null) || fail VOLUME_MISSING
  options=$(docker volume inspect --format '{{json .Options}}' "$volume" 2>/dev/null) || fail VOLUME_MISSING
  [[ $driver == local && ( $options == null || $options == '{}' ) ]] || fail VOLUME_DRIVER_UNSUPPORTED
done
assert_stopped() {
  local volume ids state
  for volume in "$app"; do
    ids=$(docker ps -aq --filter "volume=$volume" 2>/dev/null) || fail CONSUMER_CHECK_FAILED
    for id in $ids; do
      state=$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null) || fail CONSUMER_CHECK_FAILED
      case $state in created|exited|dead) ;; *) fail VOLUME_IN_USE ;; esac
    done
  done
}
assert_stopped
container="aster-backup-$(date +%s)-$RANDOM-$RANDOM"
run_helper() {
  timeout --foreground --kill-after=15s 300s docker run --rm --name "$container" --pull never \
    --network none --user 0:0 --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 256m \
    --mount "type=volume,source=$app,target=/app-data,readonly,volume-nocopy" \
    "$@" 2>/dev/null
}
code=VOLUME_PREFLIGHT_FAILED
run_helper --entrypoint node "$image" dist/src/deployment-volume-preflight.js \
  --app-volume /app-data --inbox-diagnostics >/dev/null || fail VOLUME_PREFLIGHT_FAILED
assert_stopped
code=BACKUP_SPACE_CHECK_FAILED
used=$(run_helper --entrypoint bash "$image" -ceu '
  du -sk /app-data | { total=0; while read -r size name; do total=$((total+size)); done; printf "%s" "$total"; }
') || fail BACKUP_SPACE_CHECK_FAILED
[[ $used =~ ^[0-9]+$ ]] || fail BACKUP_SPACE_CHECK_FAILED
available=$(df -Pk "$backup_root" | { read -r header; read -r fs blocks used available rest; printf '%s' "$available"; })
(( available > used * 2 + 65536 )) || fail DISK_INSUFFICIENT
code=BACKUP_DIRECTORY_FAILED
umask 077
snapshot=$(mktemp -d "$backup_root/snapshot-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
# Stream to host files instead of buffering archives in container memory. A
# partial snapshot is retained on failure and never receives a COMPLETE marker.
code=BACKUP_WRITE_FAILED
run_helper --entrypoint tar "$image" --numeric-owner -czf - -C /app-data . > "$snapshot/app-data.tgz" || fail BACKUP_WRITE_FAILED
code=BACKUP_ARCHIVE_INVALID
tar -tzf "$snapshot/app-data.tgz" ./inbox.sqlite ./agent.sqlite ./workspace/ >/dev/null 2>&1 || fail BACKUP_ARCHIVE_INVALID
code=BACKUP_CHECKSUM_FAILED
(cd "$snapshot" && sha256sum app-data.tgz > SHA256SUMS && sha256sum --check --status SHA256SUMS) || fail BACKUP_CHECKSUM_FAILED
chmod 600 "$snapshot/app-data.tgz" "$snapshot/SHA256SUMS"
assert_stopped
code=BACKUP_COMPLETE_MARKER_FAILED
printf 'volume-backup-v1\n' > "$snapshot/COMPLETE"
chmod 600 "$snapshot/COMPLETE"
finished=1
printf '{"status":"backup-complete","directory":"%s","productionAdmission":"not-evaluated"}\n' "$(basename "$snapshot")"
