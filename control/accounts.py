"""The Unix accounts mu-dsh owns: it creates them, sets their passwords, and
deletes them. It never adopts an account it did not create."""

from __future__ import annotations

import os
import pwd
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Callable

USERNAME_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}")


class AccountError(Exception):
    pass


@dataclass(frozen=True)
class Account:
    name: str
    uid: int
    gid: int
    groups: tuple[int, ...]
    home: str
    shell: str

    @property
    def dsh_home(self) -> str:
        return os.path.join(self.home, ".dsh")

    def popen_kwargs(self) -> dict:
        """Credentials for subprocess.Popen. As root, switch to the account;
        unprivileged (development runs) only the invoking user can be served."""
        if os.geteuid() == 0:
            return {"user": self.uid, "group": self.gid, "extra_groups": list(self.groups)}
        if self.uid != os.geteuid():
            raise PermissionError(f"not root: cannot run processes as {self.name}")
        return {}

    def base_env(self, path: str) -> dict[str, str]:
        return {
            "HOME": self.home,
            "USER": self.name,
            "LOGNAME": self.name,
            "SHELL": self.shell,
            "PATH": path,
            "LANG": os.environ.get("LANG", "C.UTF-8"),
        }


def check_name(name: str) -> None:
    if not USERNAME_RE.fullmatch(name):
        raise AccountError(f"invalid user name {name!r} (lowercase letters, digits, '_' and '-'; at most 32)")


def check_password(password: str) -> None:
    if not password:
        raise AccountError("password must not be empty")
    if "\n" in password or "\0" in password or len(password) > 1024:
        raise AccountError("password must be one line of at most 1024 characters")


Runner = Callable[..., subprocess.CompletedProcess]


class Accounts:
    """Creates, inspects, and deletes Unix accounts with the shadow-utils tools."""

    def __init__(self, run: Runner = subprocess.run, sleep: Callable[[float], None] = time.sleep):
        self.run = run
        self.sleep = sleep

    def exists(self, name: str) -> bool:
        try:
            pwd.getpwnam(name)
        except KeyError:
            return False
        return True

    def lookup(self, name: str) -> Account:
        """The account, or AccountError when it does not exist or may not be managed."""
        check_name(name)
        try:
            entry = pwd.getpwnam(name)
        except KeyError:
            raise AccountError(f"no Unix account named {name!r}") from None
        if entry.pw_uid == 0:
            raise AccountError("refusing to manage root")
        if not os.path.isdir(entry.pw_dir):
            raise AccountError(f"{name}'s home directory {entry.pw_dir} does not exist")
        return Account(
            name=name,
            uid=entry.pw_uid,
            gid=entry.pw_gid,
            groups=tuple(os.getgrouplist(name, entry.pw_gid)),
            home=entry.pw_dir,
            shell=entry.pw_shell or "/bin/sh",
        )

    def create(self, name: str, password: str) -> None:
        check_name(name)
        check_password(password)
        if self.exists(name):
            raise AccountError(f"a Unix account named {name!r} already exists; mu-dsh only manages accounts it creates")
        self._run(["useradd", "--create-home", "--shell", "/bin/bash", "--comment", "mu-dsh user", name])
        try:
            self.set_password(name, password)
        except AccountError:
            self._run(["userdel", "--remove", name], ok=(0, 6))
            raise

    def set_password(self, name: str, password: str) -> None:
        check_password(password)
        self._run(["chpasswd"], input=f"{name}:{password}\n")

    def delete(self, name: str) -> None:
        """End the account's processes, then remove it with its home directory."""
        if not self.exists(name):
            return
        self.lookup(name)  # refuses root
        self._run(["pkill", "-TERM", "-u", name], ok=(0, 1))
        for _ in range(50):
            if self._run(["pgrep", "-u", name], ok=(0, 1)).returncode == 1:
                break
            self.sleep(0.1)
        else:
            self._run(["pkill", "-KILL", "-u", name], ok=(0, 1))
        self._run(["userdel", "--remove", name], ok=(0, 6))  # 6: already gone

    def _run(self, cmd: list[str], *, input: str | None = None, ok: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess:
        proc = self.run(cmd, input=input, capture_output=True, text=True)
        if proc.returncode not in ok:
            raise AccountError(f"{cmd[0]} failed ({proc.returncode}): {proc.stderr.strip()}")
        return proc
