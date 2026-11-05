"""Files the control plane shares with the gateway.

``/run/mu-dsh/gateway.json`` is the only interface between the Python control
plane and the Node gateway. Format (version 1)::

    {
      "version": 1,
      "gateway": {"listen_host", "listen_port", "public_url", "session_max_age_days"},
      "session_secret": "...",
      "control_socket": "/run/mu-dsh/control.sock",
      "relay": {"listen_host", "listen_port", "upstream", "api_key"},
      "users": {
        "<name>": {"port", "llm_key", "enabled", "up", "token", "error", "mode"}
      }
    }

``token`` is the user's current dsh launch token, or null while it is not up.
``mode`` is "normal" or "recovery". Passwords are checked and workspace actions
requested over ``control_socket`` (see controlserver.py), never through here.
"""

from __future__ import annotations

import grp
import json
import os
import secrets
from pathlib import Path

from control.config import Config
from control.users import User


def render(config: Config, users: dict[str, User], session_secret: str, control_socket: str, status: dict[str, dict]) -> dict:
    """Build the gateway.json payload from configuration, users, and process status."""
    return {
        "version": 1,
        "gateway": {
            "listen_host": config.gateway.listen.host,
            "listen_port": config.gateway.listen.port,
            "public_url": config.gateway.public_url,
            "session_max_age_days": config.gateway.session_max_age_days,
        },
        "session_secret": session_secret,
        "control_socket": control_socket,
        "relay": {
            "listen_host": config.relay.listen.host,
            "listen_port": config.relay.listen.port,
            "upstream": config.llm.base_url,
            "api_key": config.llm.api_key,
        },
        "users": {
            name: {
                "port": u.port,
                "llm_key": u.llm_key,
                "enabled": u.enabled,
                "up": bool(status.get(name, {}).get("up")),
                "token": status.get(name, {}).get("token"),
                "error": status.get(name, {}).get("error"),
                "mode": status.get(name, {}).get("mode", "normal"),
            }
            for name, u in sorted(users.items())
        },
    }


class StateFile:
    """gateway.json, replaced atomically and readable by root and the gateway's group only."""

    def __init__(self, path: Path):
        self.path = path

    def write(self, payload: dict, group: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        if os.geteuid() == 0:
            try:
                os.chown(tmp, 0, grp.getgrnam(group).gr_gid)
            except KeyError:
                pass  # group missing: file stays root-only, the gateway will report it cannot read
        os.chmod(tmp, 0o640)
        os.replace(tmp, self.path)

    def read(self) -> dict | None:
        try:
            return json.loads(self.path.read_text())
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            return None


class SessionSecret:
    """The key the gateway signs its session cookies with; created on first use."""

    def __init__(self, path: Path):
        self.path = path

    def get(self) -> str:
        try:
            return self.path.read_text().strip()
        except FileNotFoundError:
            pass
        self.path.parent.mkdir(parents=True, exist_ok=True)
        secret = secrets.token_urlsafe(48)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secret + "\n")
        return secret
