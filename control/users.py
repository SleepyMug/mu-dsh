"""The managed-user registry (/var/lib/mu-dsh/users.json).

Passwords are not stored here: each managed user is a Unix account, and the
gateway checks sign-ins against it through PAM (see authserver.py).
"""

from __future__ import annotations

import contextlib
import dataclasses
import fcntl
import json
import os
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator


class UserError(Exception):
    pass


def new_llm_key() -> str:
    return "mudsh-" + secrets.token_urlsafe(32)


@dataclass
class User:
    name: str
    port: int
    llm_key: str
    enabled: bool = True


_USER_FIELDS = {f.name for f in dataclasses.fields(User)} - {"name"}


class UserStore:
    """users.json with read-modify-write under an exclusive flock."""

    def __init__(self, users_file: Path, lock_file: Path):
        self.users_file = users_file
        self.lock_file = lock_file

    def load(self) -> dict[str, User]:
        try:
            raw = json.loads(self.users_file.read_text())
        except FileNotFoundError:
            return {}
        return {
            name: User(name=name, **{k: v for k, v in fields.items() if k in _USER_FIELDS})
            for name, fields in raw.get("users", {}).items()
        }

    def add(self, name: str, port_base: int) -> User:
        with self._edit() as users:
            if name in users:
                raise UserError(f"{name} is already managed")
            user = User(name=name, port=allocate_port(users, port_base), llm_key=new_llm_key())
            users[name] = user
            return user

    def remove(self, name: str) -> User:
        with self._edit() as users:
            return users.pop(self._require(users, name).name)

    def set_enabled(self, name: str, enabled: bool) -> None:
        with self._edit() as users:
            self._require(users, name).enabled = enabled

    def rotate_llm_key(self, name: str) -> None:
        with self._edit() as users:
            self._require(users, name).llm_key = new_llm_key()

    def require(self, name: str) -> User:
        return self._require(self.load(), name)

    @staticmethod
    def _require(users: dict[str, User], name: str) -> User:
        if name not in users:
            raise UserError(f"{name} is not managed")
        return users[name]

    @contextlib.contextmanager
    def _edit(self) -> Iterator[dict[str, User]]:
        """Yield the registry under an exclusive lock; save it if the block succeeds."""
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.lock_file, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            users = self.load()
            yield users
            self._save(users)
        finally:
            os.close(fd)

    def _save(self, users: dict[str, User]) -> None:
        payload = {
            "version": 1,
            "users": {name: {k: v for k, v in asdict(u).items() if k != "name"} for name, u in sorted(users.items())},
        }
        self.users_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.users_file.with_name(self.users_file.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        os.replace(tmp, self.users_file)


def allocate_port(users: dict[str, User], port_base: int) -> int:
    """The lowest port at or above port_base no managed user holds."""
    used = {u.port for u in users.values()}
    port = port_base
    while port in used:
        port += 1
    if port > 65535:
        raise UserError("no free ports left above dsh.port_base")
    return port
