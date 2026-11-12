"""Write what every user's dsh shares, next to the dsh installs::

    /opt/mu-dsh/dsh/node_modules/mu-dsh-defaults/{package.json,cordis.patch.yml}
    /opt/mu-dsh/dsh/node_modules/<plugin>/{package.json,lib/...}   for each plugin

dsh finds a profile's bundles by package name from its own install
directory upwards, so ``versions/<v>/../../node_modules`` serves every
version.

The plugins are the source tree's ``plugins/`` (one git submodule each),
which install.sh copies to ``/opt/mu-dsh/plugins/<dir>/``: each a
``package.json`` and its built ``lib/``. The defaults bundle mounts every
one, and dsh resolves them as dependencies of the bundle, from the bundle's
directory. A plugin no longer in the source tree is removed on the next
write; the bundle's previous dependencies say which packages mu-dsh put
there.

Everything here is root-owned and world-readable; none of it is secret.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from control import managed
from control.config import Config

# npm package names, scoped or not, which are also safe as paths under node_modules.
_PACKAGE_NAME = re.compile(r"(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*")


class SiteLayerError(Exception):
    pass


@dataclass(frozen=True)
class Layers:
    digest: str  # changes whenever the shared content does


@dataclass(frozen=True)
class Plugin:
    name: str
    version: str
    files: dict[str, bytes]  # path within the package -> content


def read_plugins(source: Path) -> list[Plugin]:
    """The plugins install.sh copied to ``source``, in name order."""
    if not source.is_dir():
        raise SiteLayerError(f"{source} is missing; reinstall mu-dsh (sudo ./install.sh)")
    plugins: dict[str, Plugin] = {}
    for directory in sorted(p for p in source.iterdir() if p.is_dir()):
        manifest_path = directory / "package.json"
        try:
            manifest_bytes = manifest_path.read_bytes()
        except FileNotFoundError:
            raise SiteLayerError(f"{manifest_path} is missing; reinstall mu-dsh (sudo ./install.sh)") from None
        try:
            manifest = json.loads(manifest_bytes)
            name, version = manifest["name"], manifest["version"]
        except (ValueError, KeyError, TypeError):
            raise SiteLayerError(f"{manifest_path} must name the package and its version") from None
        if not isinstance(name, str) or not _PACKAGE_NAME.fullmatch(name) or name == managed.DEFAULTS_BUNDLE:
            raise SiteLayerError(f"{manifest_path}: {name!r} cannot be a plugin's package name")
        if not isinstance(version, str) or not version:
            raise SiteLayerError(f"{manifest_path}: the version must be a string")
        if name in plugins:
            raise SiteLayerError(f"{directory}: a second plugin named {name}")
        lib = directory / "lib"
        built = sorted(p for p in lib.rglob("*") if p.is_file()) if lib.is_dir() else []
        if not built:
            raise SiteLayerError(f"{lib} holds no built code; reinstall mu-dsh (sudo ./install.sh)")
        files = {"package.json": manifest_bytes}
        files.update((p.relative_to(directory).as_posix(), p.read_bytes()) for p in built)
        plugins[name] = Plugin(name, version, files)
    return list(plugins.values())


class SiteLayers:
    def __init__(self, root: Path, plugins_source: Path):
        self.root = root
        self.plugins_source = plugins_source

    @property
    def bundle_dir(self) -> Path:
        return self.root / "node_modules" / managed.DEFAULTS_BUNDLE

    def package_dir(self, name: str) -> Path:
        return self.root / "node_modules" / name

    def write(self, cfg: Config) -> Layers:
        plugins = read_plugins(self.plugins_source)
        names = [plugin.name for plugin in plugins]
        files: dict[Path, bytes] = {
            self.bundle_dir / "package.json": managed.bundle_manifest({p.name: p.version for p in plugins}).encode(),
            self.bundle_dir / "cordis.patch.yml": managed.defaults_text(cfg, names).encode(),
        }
        for plugin in plugins:
            for name, content in plugin.files.items():
                files[self.package_dir(plugin.name) / name] = content
        # Before the new manifest replaces the record of what was installed.
        for dropped in sorted(self._installed() - set(names)):
            self._remove(dropped)
        for path, content in files.items():
            self._write(path, content)
        for plugin in plugins:
            self._prune(self.package_dir(plugin.name), set(files))
        digest = hashlib.sha256()
        for path, content in files.items():
            digest.update(f"{path.relative_to(self.root)}\0{len(content)}\0".encode())
            digest.update(content)
        return Layers(digest=digest.hexdigest())

    def _installed(self) -> set[str]:
        """The plugins the current bundle depends on: what the previous write installed."""
        try:
            dependencies = json.loads((self.bundle_dir / "package.json").read_text())["dependencies"]
        except (FileNotFoundError, ValueError, KeyError, TypeError):
            return set()
        return {name for name in dependencies if isinstance(name, str) and _PACKAGE_NAME.fullmatch(name)}

    def _remove(self, name: str) -> None:
        directory = self.package_dir(name)
        shutil.rmtree(directory, ignore_errors=True)
        scope = directory.parent
        if scope != self.root / "node_modules" and scope.is_dir() and not any(scope.iterdir()):
            scope.rmdir()

    def _write(self, path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        directory = path.parent
        while directory != self.root.parent:  # users must be able to read everything under root
            os.chmod(directory, 0o755)
            directory = directory.parent
        try:
            if path.read_bytes() == content:
                return
        except FileNotFoundError:
            pass
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)

    @staticmethod
    def _prune(directory: Path, keep: set[Path]) -> None:
        """Remove files an older version of a plugin had and this one does not."""
        for path in sorted(directory.rglob("*"), reverse=True):
            if path.is_dir():
                if not any(path.iterdir()):
                    path.rmdir()
            elif path not in keep:
                path.unlink()
