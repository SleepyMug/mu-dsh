"""Filesystem locations. Every path can be overridden through the environment,
which the unit tests and local development runs use."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Paths:
    config: Path  # admin-edited config.toml
    state_dir: Path  # users.json, session secret
    run_dir: Path  # gateway.json, pid file
    dsh_root: Path  # pinned dsh installs: versions/<v>, current -> versions/<v>
    npm_cache: Path

    @property
    def users_file(self) -> Path:
        return self.state_dir / "users.json"

    @property
    def users_lock(self) -> Path:
        return self.state_dir / "users.lock"

    @property
    def session_secret(self) -> Path:
        return self.state_dir / "session-secret"

    @property
    def gateway_state(self) -> Path:
        return self.run_dir / "gateway.json"

    @property
    def auth_socket(self) -> Path:
        return self.run_dir / "auth.sock"

    @property
    def pid_file(self) -> Path:
        return self.run_dir / "mu-dsh.pid"

    @classmethod
    def from_env(cls) -> "Paths":
        env = os.environ
        return cls(
            config=Path(env.get("MU_DSH_CONFIG", "/etc/mu-dsh/config.toml")),
            state_dir=Path(env.get("MU_DSH_STATE_DIR", "/var/lib/mu-dsh")),
            run_dir=Path(env.get("MU_DSH_RUN_DIR", "/run/mu-dsh")),
            dsh_root=Path(env.get("MU_DSH_DSH_ROOT", "/opt/mu-dsh/dsh")),
            npm_cache=Path(env.get("MU_DSH_NPM_CACHE", "/var/cache/mu-dsh/npm")),
        )
