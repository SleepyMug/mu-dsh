"""Write mu-dsh's managed files into a user's ~/.dsh, as that user."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from control import managed
from control.accounts import Account

HELPER = Path(__file__).with_name("userfiles.py")


class ProvisionError(Exception):
    pass


class Provisioner:
    """Runs userfiles.py with the target account's credentials, so root never
    writes through a path the user controls."""

    def __init__(self, python: str = sys.executable, helper: Path = HELPER):
        self.python = python
        self.helper = helper

    def apply(self, account: Account, patch_text: str, llm_key: str) -> None:
        request = {
            "patch": patch_text,
            "env_block": managed.env_block(llm_key),
            "dsh_home": account.dsh_home,
            "patch_marker": managed.PATCH_MARKER,
            "env_begin": managed.ENV_BEGIN,
            "env_end": managed.ENV_END,
        }
        proc = subprocess.run(
            [self.python, "-I", str(self.helper)],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            cwd=account.home,
            env=account.base_env("/usr/bin:/bin"),
            timeout=30,
            **account.popen_kwargs(),
        )
        if proc.returncode != 0:
            raise ProvisionError(f"provisioning {account.name} failed: {proc.stderr.strip() or proc.returncode}")
