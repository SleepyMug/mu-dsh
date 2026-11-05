"""Prepare a user's ~/.dsh before their dsh starts, as that user."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from control import dshenv, managed
from control.accounts import Account

HELPER = Path(__file__).with_name("userfiles.py")


class ProvisionError(Exception):
    pass


@dataclass(frozen=True)
class Provision:
    account: Account
    env_block: str
    home_patch: str
    dsh: tuple[str, ...]  # node and dsh's entry script
    env: tuple[tuple[str, str], ...]
    recovery: bool = False


class Provisioner:
    """Runs dsh and userfiles.py with the target account's credentials, so root
    never writes through a path the user controls."""

    def __init__(self, python: str = sys.executable, helper: Path = HELPER):
        self.python = python
        self.helper = helper

    def apply(self, p: Provision, reset: bool = False) -> None:
        """Prepare ~/.dsh for a start. ``reset`` first sets the user's web
        profile settings aside; ``p.recovery`` rebuilds the recovery profile."""
        if p.recovery:
            recovery_dir = Path(p.account.dsh_home, "profiles", managed.RECOVERY_PROFILE)
            self._run(p, ["rm", "-rf", "--", str(recovery_dir)], None, "clearing the recovery profile")
            argv = [*p.dsh, "--profile", managed.RECOVERY_PROFILE, "--from-default-profile", managed.PROFILE, "--dump-default-config"]
            self._run(p, argv, None, "creating the recovery profile")
        for profile in managed.PROFILES:
            if not Path(p.account.dsh_home, "profiles", profile, "package.json").exists():
                # Let dsh create the profile from its own template; this only composes, it starts nothing.
                argv = [*p.dsh, "--profile", profile, "--dump-default-config"]
                self._run(p, argv, None, f"creating the dsh profile {profile}")
        request = {
            "dsh_home": p.account.dsh_home,
            "env_block": p.env_block,
            "env_begin": managed.ENV_BEGIN,
            "env_end": managed.ENV_END,
            "home_patch": p.home_patch,
            "patch_marker": managed.PATCH_MARKER,
            "bundle": managed.DEFAULTS_BUNDLE,
            "base_bundle": managed.BASE_BUNDLE,
            "reset_profile": managed.PROFILE if reset else None,
            # Recovery comments out user .env lines dsh would refuse to start with.
            "refused_env": {
                "names": sorted(dshenv.BOOTSTRAP_NAMES - dshenv.HOME_FILE_PROXY_NAMES),
                "prefixes": list(dshenv.BOOTSTRAP_PREFIXES),
            } if p.recovery else None,
        }
        self._run(p, [self.python, "-I", str(self.helper)], json.dumps(request), "provisioning")

    def _run(self, p: Provision, argv: list[str], stdin: str | None, what: str) -> None:
        proc = subprocess.run(
            argv,
            input=stdin,
            capture_output=True,
            text=True,
            cwd=p.account.home,
            env=dict(p.env),
            timeout=120,
            **p.account.popen_kwargs(),
        )
        if proc.returncode != 0:
            output = (proc.stderr or proc.stdout).strip().splitlines()[-5:]
            raise ProvisionError(f"{what} for {p.account.name} failed: {' / '.join(output) or proc.returncode}")

