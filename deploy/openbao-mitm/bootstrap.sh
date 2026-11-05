#!/usr/bin/env bash
# Operator bootstrap for the OpenBao + MITM stack. Run on the server from deploy/openbao-mitm.
#
# Order of operations (the first run stops before prompting for anything):
#   1. ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh
#      -> generates the TLS CA/server/client material and the proxy token, then exits.
#   2. docker compose up -d openbao, then `bao operator init` and `bao operator unseal`
#      (the in-container CLI uses the plaintext loopback listener; see README.md).
#   3. Rerun with secret names to write KV, the read-only OpenBao token, and the proxy token:
#      ./bootstrap.sh DEEPSEEK_API_KEY DEEPSEEK_WEB_API_KEY TELEGRAM_BOT_TOKEN
#   4. docker compose up -d mitm, then rerun once more to export the public MITM CA.
#
# Idempotent: existing TLS files, token files, KV entries, and policy updates are safe to repeat.
# Prompts for the root token and for each secret value with hidden input. Values are never printed,
# and they reach OpenBao on stdin, not in argv.
#
# usage: ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh [NAME ...]
#   NAME is an env-style name such as DEEPSEEK_API_KEY; it is stored at secret/aster/NAME, field `value`.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,18p' "$0"
  exit 0
fi

SECRETS_DIR="${ASTER_OPENBAO_SECRETS:-$HOME/Aster/secrets/openbao}"
CONTAINER="aster-openbao"
POLICY_NAME="aster-mitm-read"
TOKEN_FILE="$SECRETS_DIR/openbao-mitm-token"
PROXY_TOKEN_FILE="$SECRETS_DIR/mitm-proxy-token"
TLS_DIR="$SECRETS_DIR/tls"
MITM_CONFDIR="$SECRETS_DIR/mitmproxy"
EXPORTED_CA_CERT="$SECRETS_DIR/mitmproxy-ca.pem"

for name in "$@"; do
  if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    echo "invalid secret name: $name (expected ENV-style, e.g. DEEPSEEK_API_KEY)" >&2
    exit 2
  fi
done

umask 077
mkdir -p "$SECRETS_DIR" "$TLS_DIR"
chmod 700 "$SECRETS_DIR" "$TLS_DIR"

# --- TLS: OpenBao's 8200 listener requires a client certificate ---------------------------------
# The CA private key stays on the host (0600). The server certificate is presented by OpenBao on
# aster_vault; the client certificate is mounted only into aster-mitm for the addon's KV reads.
if [[ ! -s "$TLS_DIR/ca.pem" || ! -s "$TLS_DIR/ca-key.pem" ]]; then
  if [[ -e "$TLS_DIR/ca.pem" || -e "$TLS_DIR/ca-key.pem" ]]; then
    echo "incomplete TLS CA in $TLS_DIR (need both ca.pem and ca-key.pem); remove them to regenerate" >&2
    exit 1
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout "$TLS_DIR/ca-key.pem" -out "$TLS_DIR/ca.pem" \
    -subj "/CN=Aster OpenBao Internal CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "generated OpenBao TLS CA in $TLS_DIR"
fi
chmod 600 "$TLS_DIR/ca-key.pem"
chmod 644 "$TLS_DIR/ca.pem"

issue_cert() {
  local name="$1" cn="$2" eku="$3" san="$4"
  local cert="$TLS_DIR/$name.pem" key="$TLS_DIR/$name-key.pem"
  if [[ -s "$cert" && -s "$key" ]]; then
    return 0
  fi
  local csr extensions
  csr="$(mktemp)"
  extensions="$(mktemp)"
  openssl req -newkey rsa:2048 -nodes -sha256 -keyout "$key" -out "$csr" -subj "/CN=$cn"
  {
    echo "basicConstraints=critical,CA:FALSE"
    echo "keyUsage=critical,digitalSignature,keyEncipherment"
    echo "extendedKeyUsage=$eku"
    if [[ -n "$san" ]]; then echo "subjectAltName=$san"; fi
  } > "$extensions"
  openssl x509 -req -in "$csr" -CA "$TLS_DIR/ca.pem" -CAkey "$TLS_DIR/ca-key.pem" \
    -CAserial "$TLS_DIR/ca.srl" -CAcreateserial -days 825 -sha256 \
    -extfile "$extensions" -out "$cert"
  rm -f "$csr" "$extensions"
  echo "issued $name certificate"
}

issue_cert server aster-openbao serverAuth "DNS:aster-openbao,DNS:localhost,IP:10.89.82.2,IP:127.0.0.1"
issue_cert client aster-mitm-client clientAuth ""
chmod 644 "$TLS_DIR/server-key.pem"
chmod 600 "$TLS_DIR/client-key.pem"

# --- Proxy token: every client of the MITM listener must present it ------------------------------
if [[ -s "$PROXY_TOKEN_FILE" ]]; then
  echo "kept existing MITM proxy token file"
else
  openssl rand -hex 32 > "$PROXY_TOKEN_FILE"
  echo "generated MITM proxy token file"
fi
chmod 600 "$PROXY_TOKEN_FILE"

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q '^true$'; then
  echo
  echo "TLS material and proxy token are ready in $SECRETS_DIR."
  echo "Next: docker compose up -d openbao; initialize and unseal OpenBao, then rerun this script."
  exit 0
fi

read -rsp "OpenBao root token (hidden): " ROOT_TOKEN
echo

# Each call runs as the root token only for this step. The token goes through the container's environment.
# BAO_ADDR comes from the service environment and points at the plaintext loopback listener.
bao() {
  docker exec -i -e BAO_TOKEN="$ROOT_TOKEN" "$CONTAINER" bao "$@"
}

if ! bao secrets list | grep -q '^secret/'; then
  bao secrets enable -path=secret -version=2 kv
  echo "enabled KV v2 at secret/"
else
  echo "KV at secret/ already enabled"
fi

printf '%s\n' 'path "secret/data/aster/*" { capabilities = ["read"] }' | bao policy write "$POLICY_NAME" - >/dev/null
echo "wrote policy $POLICY_NAME (read on secret/data/aster/* only)"

if [[ -s "$TOKEN_FILE" ]]; then
  echo "kept existing token file (rotate by deleting it and rerunning)"
else
  (umask 077 && bao token create -policy="$POLICY_NAME" -orphan -period=720h -display-name=aster-mitm -field=token > "$TOKEN_FILE")
  chmod 600 "$TOKEN_FILE"
  echo "wrote read-only token file"
fi

# The mitm addon reads this value; the app mounts the same host file. Keeping a copy in KV makes the
# pairing visible to operators without exposing it to the app process.
tr -d '\n' < "$PROXY_TOKEN_FILE" | bao kv put secret/aster/MITM_PROXY_TOKEN value=- >/dev/null
echo "stored secret/aster/MITM_PROXY_TOKEN"

for name in "$@"; do
  read -rsp "value for $name (hidden): " value
  echo
  printf '%s' "$value" | bao kv put "secret/aster/$name" value=- >/dev/null
  unset value
  echo "stored secret/aster/$name"
done

unset ROOT_TOKEN

mkdir -p "$MITM_CONFDIR"
if [[ -s "$MITM_CONFDIR/mitmproxy-ca-cert.pem" ]]; then
  cp "$MITM_CONFDIR/mitmproxy-ca-cert.pem" "$EXPORTED_CA_CERT"
  chmod 644 "$EXPORTED_CA_CERT"
  echo "exported public MITM CA certificate (no private key) to: $EXPORTED_CA_CERT"
elif [[ -s "$EXPORTED_CA_CERT" ]]; then
  echo "public MITM CA certificate present at: $EXPORTED_CA_CERT"
else
  echo "MITM CA not generated yet: start the mitm service once, then copy $MITM_CONFDIR/mitmproxy-ca-cert.pem to $EXPORTED_CA_CERT"
fi
