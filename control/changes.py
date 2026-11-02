"""Coordination between the daemon's main loop and everything that can wake it."""

from __future__ import annotations

import threading


class Changes:
    """Raised by background threads and signal handlers; consumed by the main loop.

    ``mark()`` says the published gateway state is stale; ``wake()`` only
    interrupts the loop's wait (e.g. for a signal).
    """

    def __init__(self) -> None:
        self._stale = threading.Event()
        self._wake = threading.Event()

    def mark(self) -> None:
        self._stale.set()
        self._wake.set()

    def wake(self) -> None:
        self._wake.set()

    def wait(self, timeout: float) -> None:
        self._wake.wait(timeout)
        self._wake.clear()

    def take(self) -> bool:
        """True once per batch of marks."""
        if self._stale.is_set():
            self._stale.clear()
            return True
        return False
