"""Write what every user's dsh shares, next to the dsh installs::

    /opt/mu-dsh/dsh/node_modules/mu-dsh-defaults/{package.json,cordis.patch.yml}
    /opt/mu-dsh/dsh/node_modules/mu-dsh-files/{package.json,lib/index.js,lib/client.js}

dsh finds a profile's bundles by package name from its own install
directory upwards, so ``versions/<v>/../../node_modules`` serves every
version. The defaults bundle's patch mounts mu-dsh-files, which dsh
resolves as a dependency of the bundle, from the bundle's directory. Both
are root-owned and world-readable; they hold no secrets.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

from control import managed
from control.config import Config

# The built plugin as install.sh copies it from the source tree's plugin/.
PLUGIN_FILES = ("package.json", "lib/index.js", "lib/client.js")


class SiteLayerError(Exception):
    pass


@dataclass(frozen=True)
class Layers:
    digest: str  # changes whenever the shared content does


class SiteLayers:
    def __init__(self, root: Path, plugin_source: Path):
        self.root = root
        self.plugin_source = plugin_source

    @property
    def bundle_dir(self) -> Path:
        return self.root / "node_modules" / managed.DEFAULTS_BUNDLE

    @property
    def plugin_dir(self) -> Path:
        return self.root / "node_modules" / managed.FILES_PLUGIN

    def write(self, cfg: Config) -> Layers:
        plugin = {}
        for name in PLUGIN_FILES:
            source = self.plugin_source / name
            try:
                plugin[self.plugin_dir / name] = source.read_text()
            except FileNotFoundError:
                # The defaults bundle mounts the plugin; every user's dsh would fail to boot without it.
                raise SiteLayerError(f"{source} is missing; reinstall mu-dsh (sudo ./install.sh)") from None
        version = json.loads(plugin[self.plugin_dir / "package.json"])["version"]
        files = {
            self.bundle_dir / "package.json": managed.bundle_manifest(version),
            self.bundle_dir / "cordis.patch.yml": managed.defaults_text(cfg),
            **plugin,
        }
        for path, text in files.items():
            self._write(path, text)
        self._prune(self.plugin_dir, set(files))
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

    @staticmethod
    def _prune(directory: Path, keep: set[Path]) -> None:
        """Remove files an older plugin version had and this one does not."""
        for path in sorted(directory.rglob("*"), reverse=True):
            if path.is_dir():
                if not any(path.iterdir()):
                    path.rmdir()
            elif path not in keep:
                path.unlink()
