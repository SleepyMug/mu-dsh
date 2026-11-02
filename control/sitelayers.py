"""Write the defaults bundle every user's dsh shares, next to the dsh installs::

    /opt/mu-dsh/dsh/node_modules/mu-dsh-defaults/{package.json,cordis.patch.yml}

dsh finds a profile's bundles by package name from its own install
directory upwards, so ``versions/<v>/../../node_modules`` serves every
version. It is root-owned and world-readable; it holds no secrets.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from control import managed
from control.config import Config


@dataclass(frozen=True)
class Layers:
    digest: str  # changes whenever the shared content does


class SiteLayers:
    def __init__(self, root: Path):
        self.root = root

    @property
    def bundle_dir(self) -> Path:
        return self.root / "node_modules" / managed.DEFAULTS_BUNDLE

    def write(self, cfg: Config) -> Layers:
        files = {
            self.bundle_dir / "package.json": managed.bundle_manifest(),
            self.bundle_dir / "cordis.patch.yml": managed.defaults_text(cfg),
        }
        for path, text in files.items():
            self._write(path, text)
        digest = hashlib.sha256("\0".join(files.values()).encode()).hexdigest()
        return Layers(digest=digest)

    def _write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        directory = path.parent
        while directory != self.root.parent:  # users must be able to read everything under root
            os.chmod(directory, 0o755)
            directory = directory.parent
        try:
            if path.read_text() == text:
                return
        except FileNotFoundError:
            pass
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
