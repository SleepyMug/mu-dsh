"""Which environment variables dsh accepts from ``$DSH_HOME/.env``.

dsh refuses to start when a ``.env`` file sets a variable that governs how a
process launches or what it trusts (``BOOTSTRAP_NAMES`` and
``BOOTSTRAP_PREFIXES``, mirrored from @deepseek-ai/dsh-app-boot); only the
launching environment may set those. The four proxy names are the exception:
the Harness-home ``.env`` may carry them.

mu-dsh writes ``[dsh.env]`` values into the user's ``.env`` where it can, so
the user may override them below the managed block, and into the launch
environment otherwise, where they are fixed.
"""

from __future__ import annotations

import re

BOOTSTRAP_NAMES = frozenset({
    "PATH", "HOME", "USERPROFILE", "SHELL",
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
    "PERL5OPT", "PERL5LIB", "PYTHONSTARTUP", "PYTHONPATH", "RUBYOPT", "RUBYLIB",
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
    "PYTHONHOME",
    "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR",
    "GIT_ASKPASS", "SSH_ASKPASS",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT",
    "EDITOR", "VISUAL", "PAGER", "BROWSER",
    "DEEPSEEK_BASE_URL", "DEEPSEEK_SEARCH_BASE_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    "NODE_TLS_REJECT_UNAUTHORIZED",
})
BOOTSTRAP_PREFIXES = ("DSH_", "XDG_", "DYLD_", "BASH_FUNC_")
HOME_FILE_PROXY_NAMES = frozenset({"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"})

# Set by mu-dsh itself for every user's dsh.
RESERVED = frozenset({"HOME", "USER", "LOGNAME", "SHELL", "PATH", "DSH_HOME", "MUDSH_LLM_KEY"})

NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def launch_only(name: str) -> bool:
    """True when dsh would refuse ``name`` in ``$DSH_HOME/.env`` (dsh matches case-insensitively)."""
    upper = name.upper()
    if upper in HOME_FILE_PROXY_NAMES:
        return False
    return upper in BOOTSTRAP_NAMES or upper.startswith(BOOTSTRAP_PREFIXES)


def split(env: tuple[tuple[str, str], ...]) -> tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]]:
    """Split configured variables into (for ``.env``, for the launch environment)."""
    file_env = tuple((k, v) for k, v in env if not launch_only(k))
    launch_env = tuple((k, v) for k, v in env if launch_only(k))
    return file_env, launch_env
