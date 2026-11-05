#!/usr/bin/env bash
set -Eeuo pipefail

# Invoked only for this run's synthetic volumes by compose-topology.mjs.
image=$1 app=$2 restored_app=$3
for volume in "$app" "$restored_app"; do
  [[ $volume == aster-ci-topology-*-* ]] || exit 1
  docker volume inspect "$volume" >/dev/null
done
mkdir -m 700 /backups/volumes
bash /ci/backup-volumes.sh --image "$image" --app-volume "$app" \
  --backup-root /backups/volumes > /backups/result.json
snapshot=$(node -e 'const r=JSON.parse(require("fs").readFileSync("/backups/result.json","utf8"));if(r.status!=="backup-complete"||!/^snapshot-[A-Za-z0-9-]+$/.test(r.directory))process.exit(1);process.stdout.write(r.directory)')
cd "/backups/volumes/$snapshot"
[[ -s COMPLETE ]]
sha256sum --check --status SHA256SUMS
[[ $(stat -c %a app-data.tgz) == 600 ]]
restore() {
  docker run --rm --interactive --pull never --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 256m \
    --mount "type=volume,source=$2,target=/restore" --entrypoint bash "$image" -ceu '
      shopt -s dotglob nullglob
      files=(/restore/*)
      (( ${#files[@]} == 0 ))
      tar --numeric-owner --same-owner --same-permissions -xzf - -C /restore
    ' < "$1"
}
restore app-data.tgz "$restored_app"
# Full archive comparison covers hidden files and SQLite databases without
# printing any of them into the CI log.
compare() {
  docker run --rm --interactive --pull never --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
    --mount "type=volume,source=$2,target=/restore,readonly,volume-nocopy" --entrypoint tar "$image" \
    --compare --gzip --file - --directory /restore < "$1" >/dev/null 2>&1
}
compare app-data.tgz "$restored_app"
docker run --rm --pull never --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
  --mount "type=volume,source=$restored_app,target=/app-data,readonly,volume-nocopy" \
  --entrypoint node "$image" dist/src/deployment-volume-preflight.js \
  --app-volume /app-data --inbox-diagnostics >/dev/null
# Refuse backing up a live writer, even one that never opened SQLite.
writer="${app}-backup-writer"
trap 'docker rm -f "$writer" >/dev/null 2>&1 || true' EXIT
docker run --detach --name "$writer" --pull never --network none --read-only --cap-drop ALL \
  --mount "type=volume,source=$app,target=/data" --entrypoint node "$image" -e 'setInterval(()=>{},1000)' >/dev/null
if bash /ci/backup-volumes.sh --image "$image" --app-volume "$app" \
  --backup-root /backups/volumes > /backups/refused.json 2>&1; then exit 1; fi
node -e 'const r=JSON.parse(require("fs").readFileSync("/backups/refused.json","utf8"));if(r.code!=="VOLUME_IN_USE")process.exit(1)'
docker rm -f "$writer" >/dev/null
trap - EXIT
printf 'deployment-backup-rehearsal-ok\n'
