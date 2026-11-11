"""``mu-dsh serve``: the long-running root service.

SIGHUP re-reads config.toml and users.json and reconciles running processes;
SIGTERM/SIGINT stop every user's dsh and exit. It also serves the control
socket (controlserver.py): password checks and changes for the gateway, and
workspace actions (restart, recovery mode, settings reset), which it carries
out here on the main loop.

A user's recovery mode is kept in memory only: it lasts until they leave it,
and a service restart starts everyone normally.
"""

from __future__ import annotations

import logging
import signal

from control import state
from control.accounts import AccountError, Accounts
from control.changes import Changes
from control.config import Config, ConfigError, ConfigFile
from control.controlserver import ControlServer
from control.dshinstall import DshInstaller, InstallError, find_node
from control.pidfile import PidFile
from control.sitelayers import Layers, SiteLayerError, SiteLayers
from control.state import SessionSecret, StateFile
from control.supervisor import Spec, SpecBuilder, Supervisor
from control.users import User, UserStore
from control.workspace import NORMAL, RECOVER, RECOVERY, RESET, Request, WorkspaceRequests

log = logging.getLogger("mu-dsh")


class Daemon:
    def __init__(
        self,
        *,
        config_file: ConfigFile,
        users: UserStore,
        accounts: Accounts,
        installer: DshInstaller,
        site_layers: SiteLayers,
        specs: SpecBuilder,
        supervisor: Supervisor,
        changes: Changes,
        state_file: StateFile,
        session_secret: SessionSecret,
        pid_file: PidFile,
        control_server: ControlServer,
        workspaces: WorkspaceRequests,
    ):
        self.config_file = config_file
        self.users = users
        self.accounts = accounts
        self.installer = installer
        self.site_layers = site_layers
        self.specs = specs
        self.supervisor = supervisor
        self.changes = changes
        self.state_file = state_file
        self.session_secret = session_secret
        self.pid_file = pid_file
        self.control_server = control_server
        self.workspaces = workspaces

        self.cfg: Config | None = None
        self.node = ""
        self.layers: Layers | None = None
        self.current_users: dict[str, User] = {}
        self.modes: dict[str, str] = {}  # users not in NORMAL mode
        self.secret = ""
        self.reload_requested = False
        self.stop_requested = False

    def run(self) -> int:
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, self._on_signal)
        self.secret = self.session_secret.get()
        # Errors in the first load are fatal: systemd shows them and retries.
        # Serve password checks before publishing users the gateway could sign in.
        self.control_server.start(self.config_file.load().gateway.group)
        self.reload()
        self.pid_file.write()
        try:
            while not self.stop_requested:
                if self.reload_requested:
                    self.reload_requested = False
                    try:
                        self.reload()
                    except (ConfigError, InstallError, SiteLayerError) as e:
                        log.error("reload failed, keeping the previous configuration: %s", e)
                for request in self.workspaces.take():
                    self.carry_out(request)
                self.supervisor.tick()
                if self.changes.take():
                    self.publish()
                self.changes.wait(0.5)
        finally:
            log.info("stopping all dsh instances")
            self.control_server.stop()
            self.supervisor.stop_all()
            if self.cfg is not None:
                self.publish()
            self.pid_file.remove()
        return 0

    def reload(self) -> None:
        """Read config and users, publish them, and make the processes match."""
        cfg = self.config_file.load()
        node = find_node(cfg.dsh.node)
        if not self.installer.is_installed(cfg.dsh.version):
            raise InstallError(f"dsh {cfg.dsh.version} is not installed; run `mu-dsh install-dsh`")
        users = self.users.load()
        layers = self.site_layers.write(cfg)
        self.modes = {name: mode for name, mode in self.modes.items() if name in users and users[name].enabled}
        desired = self._desired_specs(cfg, users, node, layers)
        self.cfg, self.current_users, self.node, self.layers = cfg, users, node, layers
        # Publish first so the gateway stops admitting removed or disabled users
        # before their processes are stopped.
        self.publish()
        self.supervisor.apply(desired)
        log.info("loaded configuration: %d managed users, %d enabled", len(users), len(desired))

    def carry_out(self, request: Request) -> None:
        """Restart a user's dsh, in recovery mode or after a settings reset as asked."""
        name = request.user
        if self.cfg is None or self.layers is None or name not in self.supervisor.instances:
            return request.finish(f"{name}'s dsh is not managed by this service right now")
        if request.action == RECOVER:
            self.modes[name] = RECOVERY
        else:
            self.modes.pop(name, None)
        log.info("%s: %s requested", name, request.action)
        # A changed mode changes the spec, which apply() restarts; restart() covers the rest.
        self.supervisor.apply(self._desired_specs(self.cfg, self.current_users, self.node, self.layers))
        self.supervisor.restart(name, reset=request.action == RESET)
        self.publish()
        request.finish()

    def publish(self) -> None:
        """Write the current users and process status to gateway.json."""
        assert self.cfg is not None
        payload = state.render(
            self.cfg, self.current_users, self.secret, str(self.control_server.path), self.supervisor.snapshot()
        )
        self.state_file.write(payload, self.cfg.gateway.group)

    def _desired_specs(self, cfg: Config, users: dict[str, User], node: str, layers: Layers) -> dict[str, Spec]:
        desired: dict[str, Spec] = {}
        for name, user in users.items():
            if not user.enabled:
                continue
            try:
                account = self.accounts.lookup(name)
            except AccountError as e:
                log.error("skipping managed user %s: %s", name, e)
                continue
            desired[name] = self.specs.build(cfg, user, account, node, layers, self.modes.get(name, NORMAL))
        return desired

    def _on_signal(self, signum, _frame) -> None:
        if signum == signal.SIGHUP:
            self.reload_requested = True
        else:
            self.stop_requested = True
        self.changes.wake()
