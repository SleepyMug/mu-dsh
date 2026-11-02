"""Check and change Unix passwords through PAM, calling libpam via ctypes
(Python 3.13 dropped the crypt and spwd modules). Uses the PAM service
``mu-dsh`` (/etc/pam.d/mu-dsh, installed by install.sh), so locked or expired
accounts, pam_faillock, and the site's password rules apply to the web too.

Password changes run in a helper process (pamchange.py) whose real uid is
the user and effective uid root, exactly like the setuid passwd(1): PAM then
treats the change as the user's own and enforces the normal rules, which it
skips for a real root caller."""

from __future__ import annotations

import ctypes
import ctypes.util
import json
import pwd
import subprocess
import sys
from pathlib import Path
from typing import Callable
from ctypes import CFUNCTYPE, POINTER, Structure, byref, c_char_p, c_int, c_size_t, c_void_p, cast, sizeof

PAM_SUCCESS = 0
PAM_BUF_ERR = 5
PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3


class _Message(Structure):
    _fields_ = [("msg_style", c_int), ("msg", c_char_p)]


class _Response(Structure):
    # resp must be malloc'ed memory: PAM frees it.
    _fields_ = [("resp", c_void_p), ("resp_retcode", c_int)]


_CONV_FUNC = CFUNCTYPE(c_int, c_int, POINTER(POINTER(_Message)), POINTER(POINTER(_Response)), c_void_p)


class _Conv(Structure):
    _fields_ = [("conv", _CONV_FUNC), ("appdata_ptr", c_void_p)]


def _load(soname: str, short: str) -> ctypes.CDLL:
    try:
        return ctypes.CDLL(soname)
    except OSError:
        path = ctypes.util.find_library(short)
        if path is None:
            raise
        return ctypes.CDLL(path)


CHANGE_HELPER = Path(__file__).with_name("pamchange.py")


class PamAuthenticator:
    def __init__(self, service: str = "mu-dsh", python: str = sys.executable, helper: Path = CHANGE_HELPER):
        self.service = service
        self.python = python
        self.helper = helper
        libc = _load("libc.so.6", "c")
        self._calloc = libc.calloc
        self._calloc.argtypes = [c_size_t, c_size_t]
        self._calloc.restype = c_void_p
        self._strdup = libc.strdup
        self._strdup.argtypes = [c_char_p]
        self._strdup.restype = c_void_p

        pam = _load("libpam.so.0", "pam")
        self._start = pam.pam_start
        self._start.argtypes = [c_char_p, c_char_p, POINTER(_Conv), POINTER(c_void_p)]
        self._start.restype = c_int
        self._authenticate = pam.pam_authenticate
        self._authenticate.argtypes = [c_void_p, c_int]
        self._authenticate.restype = c_int
        self._acct_mgmt = pam.pam_acct_mgmt
        self._acct_mgmt.argtypes = [c_void_p, c_int]
        self._acct_mgmt.restype = c_int
        self._chauthtok = pam.pam_chauthtok
        self._chauthtok.argtypes = [c_void_p, c_int]
        self._chauthtok.restype = c_int
        self._end = pam.pam_end
        self._end.argtypes = [c_void_p, c_int]
        self._end.restype = c_int

    def check(self, user: str, password: str) -> bool:
        """True when PAM authenticates the password and allows the account."""
        rc, _ = self._transaction(user, lambda _prompt: password, [self._authenticate, self._acct_mgmt])
        return rc == PAM_SUCCESS

    def change(self, user: str, current: str, new: str) -> str | None:
        """Change the password as passwd(1) would; returns PAM's complaint, or None."""
        request = {"service": self.service, "user": user, "uid": pwd.getpwnam(user).pw_uid, "current": current, "new": new}
        proc = subprocess.run(
            [self.python, "-I", str(self.helper)], input=json.dumps(request), capture_output=True, text=True, timeout=60
        )
        try:
            return json.loads(proc.stdout)["error"]
        except (ValueError, KeyError):
            return "The password could not be changed."

    def change_as_caller(self, user: str, current: str, new: str) -> str | None:
        """Run pam_chauthtok in this process; pamchange.py calls it after dropping its real uid."""

        def answer(prompt: str) -> str:
            # pam_unix asks for the current password first, then the new one (twice).
            return current if any(w in prompt.lower() for w in ("current", "old")) else new

        rc, errors = self._transaction(user, answer, [self._chauthtok])
        if rc == PAM_SUCCESS:
            return None
        return " ".join(errors) or "The password could not be changed."

    def _transaction(self, user: str, answer: Callable[[str], str], steps: list) -> tuple[int, list[str]]:
        """Run PAM calls in order, answering hidden prompts with ``answer(prompt)``;
        returns the last status and the error messages PAM showed."""
        login = user.encode()
        errors: list[str] = []

        def converse(count, messages, responses, _appdata):
            addr = self._calloc(count, sizeof(_Response))
            if not addr:
                return PAM_BUF_ERR
            responses[0] = cast(addr, POINTER(_Response))
            for i in range(count):
                message = messages[i].contents
                text = message.msg.decode(errors="replace") if message.msg else ""
                if message.msg_style == PAM_PROMPT_ECHO_OFF:
                    responses[0][i].resp = self._strdup(answer(text).encode())
                elif message.msg_style == PAM_PROMPT_ECHO_ON:
                    responses[0][i].resp = self._strdup(login)
                elif message.msg_style == PAM_ERROR_MSG:
                    text = text.removeprefix("BAD PASSWORD: ").strip()
                    if text and text not in errors:
                        errors.append(text)
            return PAM_SUCCESS

        conv = _Conv(_CONV_FUNC(converse), None)
        handle = c_void_p()
        rc = self._start(self.service.encode(), login, byref(conv), byref(handle))
        if rc != PAM_SUCCESS:
            return rc, errors
        try:
            for step in steps:
                rc = step(handle, 0)
                if rc != PAM_SUCCESS:
                    break
            return rc, errors
        finally:
            self._end(handle, rc)
