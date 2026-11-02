"""Install the pinned @deepseek-ai/dsh under /opt/mu-dsh/dsh.

Layout::

    /opt/mu-dsh/dsh/versions/<version>/   npm -g --prefix install
    /opt/mu-dsh/dsh/current -> versions/<version>

Each version installs into a temporary directory and is renamed into place,
so a failed install never leaves a half-populated version behind.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from control.config import DshConfig

PACKAGE = "@deepseek-ai/dsh"


class InstallError(Exception):
    pass


def find_node(configured: str) -> str:
    node = configured or shutil.which("node")
    if not node or not os.access(node, os.X_OK):
        raise InstallError("node not found; install Node.js or set dsh.node in config.toml")
    return node


class DshInstaller:
    def __init__(self, root: Path, npm_cache: Path, log: Callable[[str], None] = print):
        self.root = root
        self.npm_cache = npm_cache
        self.log = log

    def version_dir(self, version: str) -> Path:
        return self.root / "versions" / version

    def entry_script(self, version: str) -> Path:
        return self._package_dir(self.version_dir(version)) / "lib" / "bin.js"

    def is_installed(self, version: str) -> bool:
        return self._installed_version(self.version_dir(version)) == version

    def ensure(self, dsh: DshConfig, node: str) -> Path:
        """Make ``current`` point at an install of ``dsh.version``; return its directory."""
        target = self.version_dir(dsh.version)
        if not self.is_installed(dsh.version):
            self._install(dsh, node, target)
        self._switch_current(dsh.version)
        return target

    # -- internals -----------------------------------------------------------

    @staticmethod
    def _package_dir(install_dir: Path) -> Path:
        return install_dir / "lib" / "node_modules" / "@deepseek-ai" / "dsh"

    def _installed_version(self, install_dir: Path) -> str | None:
        try:
            return json.loads((self._package_dir(install_dir) / "package.json").read_text()).get("version")
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def _install(self, dsh: DshConfig, node: str, target: Path) -> None:
        tmp = target.with_name(target.name + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        cmd = [_find_npm(node), "install", "--global", "--prefix", str(tmp), "--no-fund", "--no-audit", "--cache", str(self.npm_cache)]
        if dsh.npm_registry:
            cmd += ["--registry", dsh.npm_registry]
        if dsh.allow_scripts:
            # npm >= 11.20 skips dependency install scripts unless allowed by name;
            # dsh needs them (native terminal, spawn helper).
            cmd.append("--allow-scripts=" + ",".join(dsh.allow_scripts))
        cmd.append(f"{PACKAGE}@{dsh.version}")
        self.log(f"installing {PACKAGE}@{dsh.version} into {target}")
        env = {**os.environ, "PATH": f"{Path(node).parent}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
        proc = subprocess.run(cmd, env=env)
        got = self._installed_version(tmp) if proc.returncode == 0 else None
        if got != dsh.version:
            shutil.rmtree(tmp, ignore_errors=True)
            if proc.returncode != 0:
                raise InstallError(f"npm install failed with exit code {proc.returncode}")
            raise InstallError(f"npm installed {PACKAGE} {got!r}, expected {dsh.version!r}")
        shutil.rmtree(target, ignore_errors=True)
        os.replace(tmp, target)
        for path in [self.root, self.root / "versions", target]:
            os.chmod(path, 0o755)

    def _switch_current(self, version: str) -> None:
        current = self.root / "current"
        previous = os.readlink(current) if current.is_symlink() else None
        wanted = os.path.join("versions", version)
        if previous == wanted:
            return
        link_tmp = self.root / "current.tmp"
        if link_tmp.is_symlink() or link_tmp.exists():
            link_tmp.unlink()
        os.symlink(wanted, link_tmp)
        os.replace(link_tmp, current)
        self.log(f"dsh {version} is now current")
        # Keep the current and the previously current version; drop the rest.
        keep = {version, Path(previous).name if previous else None}
        for entry in (self.root / "versions").iterdir():
            if entry.name not in keep:
                self.log(f"removing old dsh install {entry}")
                shutil.rmtree(entry, ignore_errors=True)


def _find_npm(node: str) -> str:
    beside = Path(node).with_name("npm")
    npm = str(beside) if beside.exists() else shutil.which("npm")
    if not npm:
        raise InstallError("npm not found next to node or on PATH")
    return npm
