"""Workspace actions a user (through the gateway) or an admin asks for: restart
their dsh, start it in recovery mode, or reset their profile settings.

The control socket's threads only queue a request; the daemon's main loop,
which owns the supervisor, carries it out and then marks it done, so the
caller can wait until the old dsh is stopped and the new state is published.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from control.changes import Changes

RESTART = "restart"  # start again normally; also leaves recovery mode
RECOVER = "recover"  # start again without the user's own configuration
RESET = "reset"  # set the user's profile settings aside, then start normally
ACTIONS = (RESTART, RECOVER, RESET)

NORMAL = "normal"
RECOVERY = "recovery"


@dataclass
class Request:
    user: str
    action: str
    done: threading.Event = field(default_factory=threading.Event)
    error: str | None = None

    def finish(self, error: str | None = None) -> None:
        self.error = error
        self.done.set()


class WorkspaceRequests:
    """Thread-safe queue between the control socket and the daemon."""

    def __init__(self, changes: Changes):
        self.changes = changes
        self._lock = threading.Lock()
        self._pending: list[Request] = []

    def submit(self, user: str, action: str) -> Request:
        if action not in ACTIONS:
            raise ValueError(f"unknown workspace action {action!r}")
        request = Request(user, action)
        with self._lock:
            self._pending.append(request)
        self.changes.wake()
        return request

    def take(self) -> list[Request]:
        with self._lock:
            pending, self._pending = self._pending, []
        return pending
