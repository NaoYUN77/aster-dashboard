"""Client source-address allowlist for the MITM proxy port.

The listener is bound to the dedicated aster_mitm_clients interface, so only containers attached to
that network can reach the port at all. This module adds a second, independent check: only the listed
source addresses (the Aster app container) may open flows. Everything else is refused before any
placeholder handling, so a container that somehow joins the network still cannot use the proxy.
"""

import ipaddress
from typing import Sequence


# The Aster app container's fixed address on aster_mitm_clients (docker-compose.mitm.yml).
DEFAULT_ALLOW = "10.89.143.3/32"


class ClientAllowlistError(ValueError):
    pass


def parse_networks(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError as error:
            raise ClientAllowlistError(f"invalid client allowlist entry: {item}") from error
    if not networks:
        raise ClientAllowlistError("client allowlist must contain at least one CIDR")
    return networks


class ClientAllowlist:
    def __init__(self, raw: str = DEFAULT_ALLOW) -> None:
        self.networks = parse_networks(raw)

    def allows(self, peername: Sequence[object] | None) -> bool:
        """True only for a known source address; a missing or unparsable peer is refused."""
        if not peername:
            return False
        try:
            address = ipaddress.ip_address(str(peername[0]))
        except ValueError:
            return False
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        return any(address.version == network.version and address in network for network in self.networks)
