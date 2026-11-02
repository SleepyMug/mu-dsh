"""User lifecycle as the CLI drives it. A managed user is a registry entry plus
the Unix account mu-dsh created for it; the two are added and removed together."""

from __future__ import annotations

import time
from typing import Callable

from control.accounts import Accounts
from control.pidfile import PidFile
from control.state import StateFile
from control.users import User, UserError, UserStore


class UserAdmin:
    def __init__(
        self,
        store: UserStore,
        accounts: Accounts,
        pid_file: PidFile,
        state_file: StateFile,
        *,
        say: Callable[[str], None] = print,
        sleep: Callable[[float], None] = time.sleep,
        release_timeout: float = 20.0,
    ):
        self.store = store
        self.accounts = accounts
        self.pid_file = pid_file
        self.state_file = state_file
        self.say = say
        self.sleep = sleep
        self.release_timeout = release_timeout

    def add(self, name: str, password: str, port_base: int) -> User:
        if name in self.store.load():
            raise UserError(f"{name} is already managed")
        self.accounts.create(name, password)
        try:
            user = self.store.add(name, port_base)
        except BaseException:
            self.accounts.delete(name)
            raise
        self._reload()
        return user

    def remove(self, name: str) -> None:
        self.store.remove(name)
        if self._reload():
            self._wait_released(name)
        self.accounts.delete(name)

    def set_password(self, name: str, password: str) -> None:
        self.store.require(name)
        self.accounts.set_password(name, password)  # PAM sees it at the next sign-in; no reload

    def set_enabled(self, name: str, enabled: bool) -> None:
        self.store.set_enabled(name, enabled)
        self._reload()

    def rotate_llm_key(self, name: str) -> None:
        self.store.rotate_llm_key(name)
        self._reload()

    def _reload(self) -> bool:
        if self.pid_file.request_reload():
            self.say("mu-dsh reloaded")
            return True
        self.say("mu-dsh is not running; changes apply when it starts")
        return False

    def _wait_released(self, name: str) -> None:
        """Wait until the daemon has dropped the user (it publishes before stopping
        their dsh), so deleting the account cannot race a restart."""
        waited = 0.0
        while waited < self.release_timeout:
            published = (self.state_file.read() or {}).get("users", {})
            if name not in published:
                return
            self.sleep(0.2)
            waited += 0.2
        self.say(f"warning: mu-dsh did not release {name} within {self.release_timeout:.0f}s; deleting anyway")
