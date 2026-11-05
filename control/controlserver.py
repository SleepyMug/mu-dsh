"""The daemon's control socket, /run/mu-dsh/control.sock: what the gateway
(unprivileged, group mu-dsh) and the mu-dsh CLI (root) ask the root daemon to
do. Protocol: one JSON line each way::

    -> {"op": "check", "user": "alice", "password": "..."}
    <- {"ok": true}

    -> {"op": "change_password", "user": "alice", "password": "<current>", "new_password": "..."}
    <- {"ok": false, "error": "..."}

    -> {"op": "workspace", "user": "alice", "action": "restart" | "recover" | "reset"}
    <- {"ok": true}            (after the old dsh is stopped and gateway.json updated)

Only managed, enabled users are served, so the socket cannot be used to test
or change passwords of other accounts (root, system users). Workspace actions
need no password: only the gateway, which has signed the user in, and root
can connect.
"""

from __future__ import annotations

import grp
import json
import logging
import os
import socket
import socketserver
import threading
import time
from pathlib import Path
from typing import Callable, Protocol

from control.accounts import AccountError, check_password
from control.users import UserStore
from control.workspace import ACTIONS, WorkspaceRequests

log = logging.getLogger("mu-dsh.control")

MAX_REQUEST_BYTES = 8192
REFUSAL_DELAY = 2.0  # roughly pam_unix's failure delay, so refusals all look alike
WORKSPACE_TIMEOUT = 60.0  # stopping a dsh takes at most ~10s; a reload may be ahead in line


class Authenticator(Protocol):
    def check(self, user: str, password: str) -> bool: ...

    def change(self, user: str, current: str, new: str) -> str | None:
        """Change the password under the site's rules; returns the reason it was refused, or None."""
        ...


class ControlServer:
    def __init__(
        self,
        path: Path,
        users: UserStore,
        authenticator: Authenticator,
        workspaces: WorkspaceRequests,
        *,
        refusal_delay: float = REFUSAL_DELAY,
        workspace_timeout: float = WORKSPACE_TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.path = path
        self.users = users
        self.authenticator = authenticator
        self.workspaces = workspaces
        self.workspace_timeout = workspace_timeout
        self.refusal_delay = refusal_delay
        self.sleep = sleep
        self._server: socketserver.ThreadingUnixStreamServer | None = None

    def check(self, user: str, password: str) -> bool:
        record = self.users.load().get(user)
        if record is None or not record.enabled or not password or len(password) > 1024:
            self.sleep(self.refusal_delay)
            return False
        ok = self.authenticator.check(user, password)
        log.info("sign-in check for %s: %s", user, "accepted" if ok else "refused")
        return ok

    def change_password(self, user: str, current: str, new: str) -> str | None:
        """Set a new Unix password after checking the current one. Password rules
        come from PAM, as for passwd(1); returns its complaint, or None on success."""
        if not self.check(user, current):
            return "The current password is wrong."
        if new == current:
            return "The new password must differ from the current one."
        try:
            check_password(new)  # one line, no NULs: what PAM and the protocol can carry
        except AccountError as e:
            return str(e).capitalize() + "."
        error = self.authenticator.change(user, current, new)
        if error is None:
            log.info("password changed for %s from the web", user)
        else:
            log.info("password change for %s refused: %s", user, error)
        return error

    def workspace(self, user: str, action: str) -> str | None:
        """Queue a workspace action and wait until the daemon has carried it out;
        returns why it could not be, or None."""
        record = self.users.load().get(user)
        if record is None or not record.enabled:
            return f"{user} is not an enabled mu-dsh user"
        if action not in ACTIONS:
            return f"unknown action {action!r}"
        request = self.workspaces.submit(user, action)
        if not request.done.wait(self.workspace_timeout):
            return "the service is busy; try again"
        return request.error

    def start(self, group: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.unlink(missing_ok=True)
        server = socketserver.ThreadingUnixStreamServer(str(self.path), self._handler())
        server.daemon_threads = True
        os.chmod(self.path, 0o660)
        if os.geteuid() == 0:
            try:
                os.chown(self.path, 0, grp.getgrnam(group).gr_gid)
            except KeyError:
                log.error("group %s does not exist; the gateway cannot reach %s", group, self.path)
        threading.Thread(target=server.serve_forever, name="control-server", daemon=True).start()
        self._server = server
        log.info("control socket listening on %s", self.path)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        self.path.unlink(missing_ok=True)

    def _handler(self) -> type[socketserver.StreamRequestHandler]:
        server = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                reply: dict = {"ok": False}
                try:
                    request = json.loads(self.rfile.readline(MAX_REQUEST_BYTES))
                    op = request.get("op", "check")
                    user, password = request.get("user"), request.get("password")
                    if op == "workspace" and isinstance(user, str) and isinstance(request.get("action"), str):
                        error = server.workspace(user, request["action"])
                        reply = {"ok": error is None, **({"error": error} if error else {})}
                    elif isinstance(user, str) and isinstance(password, str):
                        if op == "check":
                            reply = {"ok": server.check(user, password)}
                        elif op == "change_password" and isinstance(request.get("new_password"), str):
                            error = server.change_password(user, password, request["new_password"])
                            reply = {"ok": error is None, **({"error": error} if error else {})}
                except (ValueError, AttributeError):
                    pass
                self.wfile.write(json.dumps(reply).encode() + b"\n")

        return Handler


def ask(path: Path, request: dict, timeout: float = WORKSPACE_TIMEOUT + 5) -> dict:
    """Send one request to a running daemon's control socket (used by the CLI)."""
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(timeout)
        try:
            s.connect(str(path))
        except (FileNotFoundError, ConnectionRefusedError):
            raise ConnectionError(f"mu-dsh is not running ({path} is not accepting connections)") from None
        s.sendall(json.dumps(request).encode() + b"\n")
        return json.loads(s.makefile().readline() or "{}")
