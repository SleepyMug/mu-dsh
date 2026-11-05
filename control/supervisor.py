"""Run one ``dsh web`` per managed user, as that user.

Each process prints ``dsh web: <url>?token=<launch token>`` once it listens;
the supervisor captures the token (the gateway needs it to sign a browser in)
and restarts crashed processes with exponential backoff.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit

from control import dshenv, managed
from control.accounts import Account
from control.changes import Changes
from control.config import Config
from control.dshinstall import DshInstaller
from control.hostnames import HostNames
from control.provision import Provision, Provisioner
from control.sitelayers import Layers
from control.users import User
from control.workspace import NORMAL, RECOVERY

log = logging.getLogger("mu-dsh.supervisor")

URL_LINE = re.compile(r"dsh web:\s*(\S+)")
TOKEN_IN_TEXT = re.compile(r"token=[A-Za-z0-9_-]+")
STACK_FRAME = re.compile(r"^\s+at ")
ERROR_LINE = re.compile(r"^\w*(Error|Exception)\b.*:")

OUTPUT_KEPT = 40  # recent output lines kept to explain an exit
ERROR_LINES = 12  # at most this many shown to the user
STOP_TIMEOUT = 10.0
MAX_BACKOFF = 30.0
HEALTHY_AFTER = 60.0


@dataclass(frozen=True)
class Spec:
    """Everything that determines how one user's dsh runs. A changed spec restarts the process."""

    provision: Provision
    argv: tuple[str, ...]
    cwd: str
    layers: str  # digest of the shared defaults, so changing them restarts every user
    mode: str = NORMAL

    @property
    def account(self) -> Account:
        return self.provision.account

    @property
    def env(self) -> tuple[tuple[str, str], ...]:
        return self.provision.env


class SpecBuilder:
    """Turns configuration and a user into the command line their dsh runs with."""

    def __init__(self, installer: DshInstaller, hostnames: HostNames):
        self.installer = installer
        self.hostnames = hostnames

    def build(self, cfg: Config, user: User, account: Account, node: str, layers: Layers, mode: str = NORMAL) -> Spec:
        """``mode`` RECOVERY runs the recovery profile, started in ~/.dsh so that a
        ~/.env the user keeps for their own projects is not read either."""
        recovery = mode == RECOVERY
        # dsh refuses requests whose Host is not loopback or a trusted host, so it must
        # trust what browsers type: the public URL's host, or else any of our own names.
        if cfg.gateway.public_url:
            reach = ["--public-url", f"{cfg.gateway.public_url}/u/{user.name}/", "--trusted-host", cfg.public_host]
        else:
            reach = [arg for host in self.hostnames.authorities() for arg in ("--trusted-host", host)]
        dsh = (node, str(self.installer.entry_script(cfg.dsh.version)))
        argv = (
            *dsh,
            "--profile", managed.RECOVERY_PROFILE if recovery else managed.PROFILE,
            "--no-open",
            "--host", "127.0.0.1",
            "--port", str(user.port),
            *reach,
            *cfg.dsh.extra_args,
        )
        path = ":".join(dict.fromkeys([str(Path(node).parent), "/usr/local/bin", "/usr/bin", "/bin"]))
        file_env, launch_env = dshenv.split(cfg.dsh.env)
        env = {**dict(launch_env), **account.base_env(path), "DSH_HOME": account.dsh_home}
        provision = Provision(
            account=account,
            env_block=managed.env_block(user.llm_key, file_env),
            home_patch=managed.policy_text(),
            dsh=dsh,
            env=tuple(sorted(env.items())),
            recovery=recovery,
        )
        cwd = account.dsh_home if recovery else account.home
        return Spec(provision=provision, argv=argv, cwd=cwd, layers=layers.digest, mode=mode)


def token_from_line(line: str) -> str | None:
    m = URL_LINE.search(line)
    if not m:
        return None
    tokens = parse_qs(urlsplit(m.group(1)).query).get("token")
    return tokens[0] if tokens else None


class Launcher:
    """Starts and stops one user's dsh process."""

    def __init__(self, provisioner: Provisioner):
        self.provisioner = provisioner

    def start(self, spec: Spec, reset: bool = False) -> subprocess.Popen:
        self.provisioner.apply(spec.provision, reset=reset)
        return subprocess.Popen(
            list(spec.argv),
            env=dict(spec.env),
            cwd=spec.cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group: stopping kills dsh's children too
            **spec.account.popen_kwargs(),
        )

    def signal(self, proc: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass

    def stop(self, procs: list[subprocess.Popen], timeout: float = STOP_TIMEOUT) -> None:
        """SIGTERM every process group, then SIGKILL what is left after ``timeout``."""
        procs = [p for p in procs if p.poll() is None]
        for proc in procs:
            self.signal(proc, signal.SIGTERM)
        deadline = time.monotonic() + timeout
        for proc in procs:
            try:
                proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                log.warning("pid %d ignored SIGTERM; killing", proc.pid)
                self.signal(proc, signal.SIGKILL)
                proc.wait()


@dataclass
class Instance:
    spec: Spec
    proc: subprocess.Popen | None = None
    token: str | None = None
    started_at: float = 0.0
    failures: int = 0
    next_start: float = 0.0
    last_error: str | None = None
    reset_next: bool = False  # set the profile settings aside before the next start
    output: deque = field(default_factory=lambda: deque(maxlen=OUTPUT_KEPT), repr=False)
    reader: threading.Thread | None = field(default=None, repr=False)

    @property
    def name(self) -> str:
        return self.spec.account.name

    @property
    def up(self) -> bool:
        return self.proc is not None and self.proc.poll() is None and self.token is not None


class Supervisor:
    """Keeps the running dsh processes equal to the desired set of specs."""

    def __init__(self, launcher: Launcher, changes: Changes, clock: Callable[[], float] = time.monotonic):
        self.launcher = launcher
        self.changes = changes
        self.clock = clock
        self.instances: dict[str, Instance] = {}
        self.lock = threading.Lock()

    def apply(self, desired: dict[str, Spec]) -> None:
        """Stop instances no longer wanted, restart changed ones, add new ones."""
        for name in list(self.instances):
            inst = self.instances[name]
            if name not in desired:
                log.info("stopping %s (no longer managed or disabled)", name)
                self._stop(inst)
                del self.instances[name]
            elif desired[name] != inst.spec:
                log.info("restarting %s (configuration changed)", name)
                self._stop(inst)
                inst.spec = desired[name]
                inst.failures = 0
                inst.next_start = 0.0
        for name, spec in desired.items():
            if name not in self.instances:
                self.instances[name] = Instance(spec=spec)
        self.changes.mark()

    def tick(self) -> None:
        """Notice exits, schedule restarts with backoff, and start what is due."""
        now = self.clock()
        for inst in self.instances.values():
            proc = inst.proc
            if proc is not None and proc.poll() is not None:
                ran = now - inst.started_at
                inst.failures = 0 if ran >= HEALTHY_AFTER else inst.failures + 1
                delay = 0.0 if inst.failures == 0 else _backoff(inst.failures)
                inst.last_error = f"exited with status {proc.returncode} after {ran:.0f}s"
                if inst.reader is not None:
                    inst.reader.join(timeout=1)  # let it collect the last lines
                explanation = error_summary(list(inst.output))
                if explanation:
                    inst.last_error += ":\n" + explanation
                log.warning("%s's dsh %s; restarting in %.0fs", inst.name, inst.last_error, delay)
                with self.lock:
                    inst.proc = None
                    inst.token = None
                inst.next_start = now + delay
                self.changes.mark()
            if inst.proc is None and now >= inst.next_start:
                self._start(inst)

    def restart(self, name: str, reset: bool = False) -> None:
        """Stop the user's dsh now and start it again on the next tick, skipping
        any backoff. ``reset`` sets their profile settings aside first."""
        inst = self.instances.get(name)
        if inst is None:
            raise KeyError(name)
        self._stop(inst)
        inst.failures = 0
        inst.next_start = 0.0
        inst.reset_next = inst.reset_next or reset
        inst.last_error = None
        self.changes.mark()

    def stop_all(self) -> None:
        self.launcher.stop([i.proc for i in self.instances.values() if i.proc is not None])
        with self.lock:
            for inst in self.instances.values():
                inst.proc = None
                inst.token = None

    def snapshot(self) -> dict[str, dict]:
        with self.lock:
            return {
                name: {
                    "up": inst.up,
                    "token": inst.token if inst.up else None,
                    "error": inst.last_error,
                    "mode": inst.spec.mode,
                }
                for name, inst in self.instances.items()
            }

    def _start(self, inst: Instance) -> None:
        try:
            proc = self.launcher.start(inst.spec, reset=inst.reset_next)
            inst.reset_next = False
        except Exception as e:  # provisioning or exec failure: back off and retry
            inst.failures += 1
            delay = _backoff(inst.failures)
            inst.last_error = str(e)
            inst.next_start = self.clock() + delay
            log.error("cannot start dsh for %s: %s; retrying in %.0fs", inst.name, e, delay)
            self.changes.mark()
            return
        log.info("started dsh for %s (pid %d)", inst.name, proc.pid)
        with self.lock:
            inst.proc = proc
            inst.token = None
            inst.started_at = self.clock()
            inst.output.clear()
        inst.reader = threading.Thread(target=self._read_output, args=(inst, proc), daemon=True, name=f"dsh-{inst.name}")
        inst.reader.start()

    def _read_output(self, inst: Instance, proc: subprocess.Popen) -> None:
        """Forward the process's output to the log and capture its launch token."""
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            token = token_from_line(line)
            if token:
                with self.lock:
                    if inst.proc is proc:
                        inst.token = token
                        inst.last_error = None
                self.changes.mark()
            line = TOKEN_IN_TEXT.sub("token=<redacted>", line)
            inst.output.append(line)
            log.info("[%s] %s", inst.name, line)

    def _stop(self, inst: Instance) -> None:
        with self.lock:
            proc, inst.proc, inst.token = inst.proc, None, None
        if proc is not None:
            self.launcher.stop([proc])


def error_summary(lines: list[str]) -> str:
    """The part of a dead process's output that explains it: from its last
    error line on, without stack frames; else its last few lines."""
    lines = [l for l in lines if l.strip() and not STACK_FRAME.match(l)]
    starts = [i for i, l in enumerate(lines) if ERROR_LINE.match(l)]
    if starts:
        lines = lines[starts[-1]:]
    return "\n".join(lines[:ERROR_LINES] if starts else lines[-ERROR_LINES:])


def _backoff(failures: int) -> float:
    return min(MAX_BACKOFF, 2.0 ** (failures - 1))
