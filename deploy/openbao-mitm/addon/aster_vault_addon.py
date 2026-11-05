"""mitmproxy addon: swap __vault_<NAME>__ placeholders in outbound requests for OpenBao values.

Scope of substitution, deliberately narrow:
- Request headers and the URL path (before any '?'). Request bodies are never touched: the web_fetch
  tool sends a model-supplied URL inside a body to DeepSeek, and a body substitution would hand a real
  key to a third party.
- Only for the (name, host) pairs in allowlist.json. Any other placeholder use is answered with 403.
- Only for source addresses in ASTER_PROXY_CLIENT_ALLOW (the Aster app container by default) and only
  with a valid proxy token (Proxy-Authorization). The listener is also bound to the dedicated
  aster_mitm_clients interface in compose.yml, so these are independent gates rather than the only one.
- OpenBao is reached over TLS with the addon's client certificate; the proxy core has neither, so a
  client cannot use this proxy (or any other route) to read OpenBao's unauthenticated health endpoint.

Run with `mitmdump -q` only. Verbose flow output prints request URLs, which would show a real
Telegram bot token that this addon has just put into the path.
"""

import json
import os
import ssl
import time
import urllib.request

from mitmproxy import ctx, http

from client_allowlist import DEFAULT_ALLOW, ClientAllowlist
from proxy_token import ProxyTokenGate
from vault_placeholders import PlaceholderError, has_placeholder, substitute, substitute_header

CACHE_SECONDS = 300
ADDON_DIR = os.path.dirname(os.path.abspath(__file__))


class OpenBaoKV:
    """Reads secret/aster/<NAME> (KV v2, field `value`) with a short in-memory cache."""

    def __init__(
        self,
        addr: str,
        token_file: str,
        ca_file: str,
        client_cert_file: str,
        client_key_file: str,
    ) -> None:
        self.addr = addr.rstrip("/")
        self.token_file = token_file
        self.cache: dict[str, tuple[str, float]] = {}
        context = ssl.create_default_context(cafile=ca_file)
        context.load_cert_chain(client_cert_file, client_key_file)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        # No proxies: the addon talks to OpenBao directly on aster_vault, never through itself.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context),
        )

    def __call__(self, name: str) -> str:
        cached = self.cache.get(name)
        now = time.monotonic()
        if cached and now - cached[1] < CACHE_SECONDS:
            return cached[0]
        value = self._fetch(name)
        self.cache[name] = (value, now)
        return value

    def _fetch(self, name: str) -> str:
        with open(self.token_file, encoding="utf-8") as handle:
            token = handle.read().strip()
        request = urllib.request.Request(
            f"{self.addr}/v1/secret/data/aster/{name}",
            headers={"X-Vault-Token": token},
        )
        with self.opener.open(request, timeout=5) as response:
            body = json.load(response)
        return body["data"]["data"]["value"]


class AsterVault:
    def __init__(self) -> None:
        allowlist_path = os.environ.get("ASTER_VAULT_ALLOWLIST", os.path.join(ADDON_DIR, "allowlist.json"))
        with open(allowlist_path, encoding="utf-8") as handle:
            self.allowlist: dict[str, list[str]] = json.load(handle)
        self.resolve = OpenBaoKV(
            os.environ["OPENBAO_ADDR"],
            os.environ["OPENBAO_TOKEN_FILE"],
            os.environ["OPENBAO_CA_FILE"],
            os.environ["OPENBAO_CLIENT_CERT_FILE"],
            os.environ["OPENBAO_CLIENT_KEY_FILE"],
        )
        self.clients = ClientAllowlist(os.environ.get("ASTER_PROXY_CLIENT_ALLOW", DEFAULT_ALLOW))
        self.tokens = ProxyTokenGate.from_file(os.environ["ASTER_PROXY_TOKEN_FILE"])

    def _refuse_unlisted_client(self, flow: http.HTTPFlow) -> bool:
        if self.clients.allows(flow.client_conn.peername):
            return False
        # No address detail in the log: the rule itself is enough to diagnose a misconfiguration.
        ctx.log.warn("aster-vault blocked client: source address not in ASTER_PROXY_CLIENT_ALLOW")
        flow.response = http.Response.make(403, b"client not permitted\n", {"Content-Type": "text/plain"})
        return True

    def _refuse_missing_token(self, flow: http.HTTPFlow) -> bool:
        if self.tokens.allows(flow.request.headers.get("Proxy-Authorization")):
            # Do not hand the shared token to the destination on plain HTTP requests.
            flow.request.headers = http.Headers(
                [(key, value) for key, value in flow.request.headers.fields if key.lower() != "proxy-authorization"]
            )
            return False
        ctx.log.warn("aster-vault blocked client: missing or invalid proxy token")
        flow.response = http.Response.make(
            407,
            b"proxy authentication required\n",
            {"Proxy-Authenticate": 'Basic realm="aster-mitm"', "Content-Type": "text/plain"},
        )
        return True

    def http_connect(self, flow: http.HTTPFlow) -> None:
        if self._refuse_unlisted_client(flow):
            return
        # The CONNECT request carries the credentials; the decrypted HTTPS requests do not.
        self._refuse_missing_token(flow)

    def request(self, flow: http.HTTPFlow) -> None:
        if self._refuse_unlisted_client(flow):
            return
        # CONNECT was already authenticated in http_connect; decrypted HTTPS requests carry no header.
        if flow.request.scheme != "https" and self._refuse_missing_token(flow):
            return
        host = flow.request.pretty_host
        path, separator, query = flow.request.path.partition("?")
        headers = flow.request.headers.fields
        touched = has_placeholder(path) or any(has_placeholder(value.decode("latin-1")) for _, value in headers)
        if not touched:
            return
        try:
            new_path = substitute(path, host, self.allowlist, self.resolve)
            new_headers = [
                (key, substitute_header(value.decode("latin-1"), host, self.allowlist, self.resolve).encode("latin-1"))
                for key, value in headers
            ]
        except PlaceholderError as error:
            # The message names the placeholder and host only; no value is ever included.
            ctx.log.warn(f"aster-vault blocked request: {error}")
            flow.response = http.Response.make(403, b"placeholder not permitted\n", {"Content-Type": "text/plain"})
            return
        flow.request.path = new_path + separator + query
        flow.request.headers = http.Headers(new_headers)


addons = [AsterVault()]
