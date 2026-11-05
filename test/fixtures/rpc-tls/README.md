# RPC TLS test fixtures

These files are **test-only** certificates for the Phase 0 loopback TLS/mTLS tests. They are not
deployment credentials and must never be used outside the test suite. The `ca.key` and
`other-ca.key` files exist only so the tests can prove that an unknown CA and a missing client
certificate are rejected.

The server certificate has `DNS:localhost` and `IP:127.0.0.1` SANs. The accepted client certificate
has `CN=aster-test-gateway`; `other-client` is signed by the same CA but has
`CN=aster-other-gateway`, so tests can prove the Agent's client-CN allowlist rejects it. The test
suite connects to `127.0.0.1` with `servername=localhost`.
