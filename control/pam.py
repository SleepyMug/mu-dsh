"""Check and change Unix passwords through PAM, calling libpam via ctypes
(Python 3.13 dropped the crypt and spwd modules). Uses the PAM service
``mu-dsh`` (/etc/pam.d/mu-dsh, installed by install.sh), so locked or expired
accounts, pam_faillock, and the site's password-quality rules
(pam_pwquality, /etc/security/pwquality.conf) apply to the web too."""

from __future__ import annotations

import ctypes
import ctypes.util
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


class PamAuthenticator:
    def __init__(self, service: str = "mu-dsh"):
        self.service = service
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
        rc, _ = self._transaction(user, password, [self._authenticate, self._acct_mgmt])
        return rc == PAM_SUCCESS

    def change(self, user: str, new_password: str) -> str | None:
        """Set a new password through the service's ``password`` stack, which
        enforces the site's quality rules. Returns PAM's complaint, or None."""
        rc, errors = self._transaction(user, new_password, [self._chauthtok])
        if rc == PAM_SUCCESS:
            return None
        return " ".join(errors) or "The password could not be changed."

    def _transaction(self, user: str, secret: str, steps: list) -> tuple[int, list[str]]:
        """Run PAM calls in order, answering hidden prompts with ``secret``;
        returns the last status and the error messages PAM showed."""
        login = user.encode()
        answer = secret.encode()
        errors: list[str] = []

        def converse(count, messages, responses, _appdata):
            addr = self._calloc(count, sizeof(_Response))
            if not addr:
                return PAM_BUF_ERR
            responses[0] = cast(addr, POINTER(_Response))
            for i in range(count):
                message = messages[i].contents
                if message.msg_style == PAM_PROMPT_ECHO_OFF:
                    responses[0][i].resp = self._strdup(answer)
                elif message.msg_style == PAM_PROMPT_ECHO_ON:
                    responses[0][i].resp = self._strdup(login)
                elif message.msg_style == PAM_ERROR_MSG and message.msg:
                    text = message.msg.decode(errors="replace").removeprefix("BAD PASSWORD: ").strip()
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
