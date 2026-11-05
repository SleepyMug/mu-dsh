"""Composition root: the one place that constructs the control plane's objects.

Everything else receives its collaborators through its constructor, so this
module reads as a map of the system.
"""

from __future__ import annotations

from dataclasses import dataclass

from control.accounts import Accounts
from control.admin import UserAdmin
from control.changes import Changes
from control.config import ConfigFile
from control.controlserver import ControlServer
from control.daemon import Daemon
from control.dshinstall import DshInstaller
from control.hostnames import HostNames
from control.pam import PamAuthenticator
from control.paths import Paths
from control.pidfile import PidFile
from control.provision import Provisioner
from control.sitelayers import SiteLayers
from control.state import SessionSecret, StateFile
from control.supervisor import Launcher, SpecBuilder, Supervisor
from control.users import UserStore
from control.workspace import WorkspaceRequests


@dataclass(frozen=True)
class Services:
    """Long-lived collaborators shared by the CLI commands and the daemon."""

    paths: Paths
    config_file: ConfigFile
    accounts: Accounts
    users: UserStore
    admin: UserAdmin
    provisioner: Provisioner
    installer: DshInstaller
    state_file: StateFile
    session_secret: SessionSecret
    pid_file: PidFile


def build_services(paths: Paths) -> Services:
    accounts = Accounts()
    users = UserStore(paths.users_file, paths.users_lock)
    state_file = StateFile(paths.gateway_state)
    pid_file = PidFile(paths.pid_file)
    return Services(
        paths=paths,
        config_file=ConfigFile(paths.config),
        accounts=accounts,
        users=users,
        admin=UserAdmin(users, accounts, pid_file, state_file),
        provisioner=Provisioner(),
        installer=DshInstaller(paths.dsh_root, paths.npm_cache),
        state_file=state_file,
        session_secret=SessionSecret(paths.session_secret),
        pid_file=pid_file,
    )


def build_daemon(services: Services) -> Daemon:
    changes = Changes()
    workspaces = WorkspaceRequests(changes)
    return Daemon(
        config_file=services.config_file,
        users=services.users,
        accounts=services.accounts,
        installer=services.installer,
        site_layers=SiteLayers(services.paths.dsh_root),
        specs=SpecBuilder(services.installer, HostNames()),
        supervisor=Supervisor(Launcher(services.provisioner), changes),
        changes=changes,
        state_file=services.state_file,
        session_secret=services.session_secret,
        pid_file=services.pid_file,
        control_server=ControlServer(services.paths.control_socket, services.users, PamAuthenticator(), workspaces),
        workspaces=workspaces,
    )
