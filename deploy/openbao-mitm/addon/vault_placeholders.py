"""Placeholder substitution policy for the Aster MITM addon.

Kept free of mitmproxy imports so the policy can be unit-tested without the proxy or OpenBao.
A placeholder is __vault_<NAME>__ and may be replaced only when the request host is listed for
that NAME in the allowlist. Host matching is exact: a suffix match would let a look-alike host
receive a credential.
"""

import base64
import binascii
import re
from collections.abc import Callable, Mapping

PLACEHOLDER = re.compile(r"__vault_([A-Z][A-Z0-9_]*?)__")


class PlaceholderError(Exception):
    """A placeholder may not be sent to this host. Messages never contain a secret value."""


def placeholder_names(text: str) -> list[str]:
    return PLACEHOLDER.findall(text)


def _decode_basic(value: str) -> tuple[str, str] | None:
    """Return (scheme, decoded credential) for a Basic header, or None for anything else."""
    scheme, separator, encoded = value.partition(" ")
    if not separator or scheme.lower() != "basic" or not encoded.strip():
        return None
    try:
        decoded = base64.b64decode(encoded.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    return scheme, decoded


def has_placeholder(value: str) -> bool:
    """True when a header carries a placeholder, including one inside Basic credentials."""
    if PLACEHOLDER.search(value):
        return True
    basic = _decode_basic(value)
    return basic is not None and PLACEHOLDER.search(basic[1]) is not None


def substitute_header(
    value: str,
    host: str,
    allowlist: Mapping[str, list[str]],
    resolve: Callable[[str], str],
) -> str:
    """Substitute a header value, decoding Basic credentials before matching placeholders.

    Langfuse (and any HTTP Basic client) encodes `user:password` before sending, so a placeholder
    in the secret would otherwise reach the destination unresolved.
    """
    basic = _decode_basic(value)
    if basic is None or PLACEHOLDER.search(basic[1]) is None:
        return substitute(value, host, allowlist, resolve)
    scheme, decoded = basic
    replaced = substitute(decoded, host, allowlist, resolve)
    return f"{scheme} {base64.b64encode(replaced.encode('utf-8')).decode('ascii')}"


def substitute(
    text: str,
    host: str,
    allowlist: Mapping[str, list[str]],
    resolve: Callable[[str], str],
) -> str:
    """Replace every placeholder in text for host, or raise PlaceholderError without replacing any."""
    host = host.lower()

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if host not in allowlist.get(name, ()):
            raise PlaceholderError(f"placeholder {name} is not permitted for host {host}")
        try:
            return resolve(name)
        except Exception:
            # The resolver's exception text may carry transport detail; keep only the name.
            raise PlaceholderError(f"placeholder {name} could not be resolved") from None

    return PLACEHOLDER.sub(replace, text)
