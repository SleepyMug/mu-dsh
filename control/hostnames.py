"""The machine's own addresses and names. Without a configured public URL,
each user's dsh trusts these as browser-visible hosts, so the gateway works
whichever of them users type."""

from __future__ import annotations

import json
import socket
import subprocess
from typing import Callable

Runner = Callable[..., subprocess.CompletedProcess]


class HostNames:
    def __init__(self, run: Runner = subprocess.run):
        self.run = run

    def authorities(self) -> list[str]:
        """Global IPv4 addresses, then the hostname and FQDN; loopback is trusted by dsh anyway.
        Only IPv4 is listed: dsh's acceptance of bracketed IPv6 literals here is untested."""
        names: list[str] = []
        try:
            out = self.run(["ip", "-json", "-4", "addr", "show", "scope", "global"], capture_output=True, text=True).stdout
            for iface in json.loads(out or "[]"):
                names += [a["local"] for a in iface.get("addr_info", []) if a.get("local")]
        except (OSError, ValueError, KeyError):
            pass
        names += [socket.gethostname(), socket.getfqdn()]
        return [n for n in dict.fromkeys(names) if n and n != "localhost"]
