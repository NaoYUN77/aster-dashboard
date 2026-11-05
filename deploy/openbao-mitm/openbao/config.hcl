# Single-node OpenBao. No ports are published. The network listener speaks TLS and requires a client
# certificate: reaching port 8200 (from aster_vault, or by asking aster-mitm to proxy to it) is not
# enough to call /v1/sys/health or any other API without the client certificate held by the addon.
#
# Why: /v1/sys/health answers unauthenticated by design and OpenBao has no switch to disable it.
# Source-address filtering alone cannot stop the app from asking the proxy for 10.89.82.2:8200, so the
# transport itself is gated. mitmproxy's proxy core neither trusts this CA nor has a client
# certificate, so a proxied request fails at the TLS handshake. Only the addon process presents the
# certificate, and it only reads secret/aster/<NAME>.
#
# The loopback listener stays plaintext so the container health check and `docker exec ... bao` keep
# working without certificates; 127.0.0.1 is not reachable from any Docker network.
ui = false
disable_mlock = true
api_addr = "https://aster-openbao:8200"

storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address                            = "0.0.0.0:8200"
  tls_cert_file                      = "/openbao/tls/server.pem"
  tls_key_file                       = "/openbao/tls/server-key.pem"
  tls_client_ca_file                 = "/openbao/tls/ca.pem"
  tls_require_and_verify_client_cert = true
  tls_min_version                    = "tls12"
}

listener "tcp" {
  address     = "127.0.0.1:8201"
  tls_disable = true
}
