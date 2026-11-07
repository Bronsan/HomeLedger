"""Where this server is, and who is allowed to talk to it.

Two questions, both of which look trivial until a machine has more than one
network interface:

  * **What address should a printed QR point at?** Not `127.0.0.1`, which is
    what the desktop application itself uses, and not `request.base_url` when
    the request came over the loopback. The IP a phone on the same Wi-Fi can
    reach is the one the kernel would use to send a packet off this host.
  * **Is this request from the family's own network?** The sticker viewer is
    meant to be useless on the open internet, so the check has to be on the
    socket address, not on a header the client controls.
"""

from __future__ import annotations

import ipaddress
import socket

from ..config import settings


def is_lan_address(host: str) -> bool:
    """Private, loopback or link-local — i.e. the same building."""
    if not host:
        return False
    candidate = host.strip().strip("[]")
    # IPv6 with a zone index, e.g. fe80::1%eth0
    candidate = candidate.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    # Explicit ranges: ip.is_private also includes documentation/reserved ranges
    # and does not mean that an address shares this household's network.
    if ip.version == 6 and ip.ipv4_mapped:
        return is_lan_address(str(ip.ipv4_mapped))
    networks = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16") if ip.version == 4 else ("fc00::/7", "fe80::/10", "::1/128")
    return any(ip in ipaddress.ip_network(net) for net in networks)


def client_is_lan(host: str | None) -> bool:
    return bool(host) and is_lan_address(host or "")


def primary_ipv4() -> str | None:
    """The IPv4 address other devices on this network would use.

    A UDP socket to a routable address never sends a packet — `connect` only
    asks the kernel to pick a route and a source address. It therefore works
    with no internet at all, which matters: a home server in a cupboard with a
    dead uplink still has to print stickers that work.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.2)
        sock.connect(("192.0.2.1", 9))  # TEST-NET-1, guaranteed unroutable
        addr = sock.getsockname()[0]
        if addr and not addr.startswith("127."):
            return addr
    except OSError:
        pass
    finally:
        sock.close()

    try:
        addr = socket.gethostbyname(socket.gethostname())
        if addr and not addr.startswith("127."):
            return addr
    except OSError:
        pass
    return None


def public_base(port: int | None = None) -> str:
    """Base URL for printed stickers, without a trailing slash.

    Preference order:
      1. `HOMELEDGER_QR_PUBLIC_BASE` — a family that gave the server a name.
      2. The primary LAN address plus whatever port the server is on.
      3. Loopback, which only works on the server itself but is at least
         honest about it.
    """
    configured = (settings.qr_public_base or "").strip().rstrip("/")
    if configured:
        return configured

    ip = primary_ipv4()
    if not ip:
        return f"http://127.0.0.1:{port}" if port else "http://127.0.0.1"
    return f"http://{ip}:{port}" if port else f"http://{ip}"


def qr_reachable_from_lan() -> bool:
    """Can a phone actually open a printed sticker?

    False when the server is bound to loopback: the URL is still generated
    (the user may fix the binding later and reprint), but the UI says so
    instead of letting someone print fifty useless labels.

    Note the asymmetry with :func:`is_lan_address`, which *does* accept
    loopback. That function answers "is this client local?" — a request from
    127.0.0.1 is as local as it gets. This one answers "can another device
    dial this address?", and 127.0.0.1 is the one private address that is
    guaranteed not to work from anywhere else.
    """
    host = (settings.bind_host or "").strip().strip("[]")
    if host in {"", "0.0.0.0", "::"}:
        return True
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        # A name, not an address: "localhost" is loopback by definition, and
        # any other name is presumably dialable from the network — we cannot
        # resolve it here without guessing, so we do not block the user.
        return host.lower() not in {"localhost", "localhost.localdomain", "ip6-localhost"}
    return not ip.is_loopback
