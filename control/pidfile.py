"""The running daemon's pid file, used by the CLI to request reloads."""

from __future__ import annotations

import os
import signal
from pathlib import Path


class PidFile:
    def __init__(self, path: Path):
        self.path = path

    def write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(f"{os.getpid()}\n")

    def remove(self) -> None:
        self.path.unlink(missing_ok=True)

    def request_reload(self) -> bool:
        """SIGHUP the running daemon. Returns False when none is running."""
        try:
            os.kill(int(self.path.read_text().strip()), signal.SIGHUP)
        except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
            return False
        return True
