"""mu-dsh command line: parses arguments and calls the services built in wiring.py."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from control.accounts import AccountError, check_name, check_password
from control.config import ConfigError
from control.dshinstall import InstallError, find_node
from control.paths import Paths
from control.provision import ProvisionError
from control.users import UserError
from control.wiring import Services, build_daemon, build_services


def _read_password(args) -> str:
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != password:
            raise UserError("passwords do not match")
    check_password(password)
    return password


def cmd_serve(s: Services, args) -> int:
    return build_daemon(s).run()


def cmd_install_dsh(s: Services, args) -> int:
    cfg = s.config_file.load()
    s.installer.ensure(cfg.dsh, find_node(cfg.dsh.node))
    return 0


def cmd_check_config(s: Services, args) -> int:
    cfg = s.config_file.load()
    reach = cfg.gateway.public_url or "any of this host's addresses"
    print(f"{s.config_file.path}: OK (reached at {reach}, {len(cfg.llm.models)} model(s), dsh {cfg.dsh.version})")
    return 0


def cmd_user_add(s: Services, args) -> int:
    cfg = s.config_file.load()
    check_name(args.name)
    password = _read_password(args)
    user = s.admin.add(args.name, password, cfg.dsh.port_base)
    print(f"created Unix account {user.name} (dsh port {user.port}): {cfg.gateway.public_url}/u/{user.name}/")
    if not cfg.gateway.public_url:
        print("  (no public_url set: users open http://<this host>:<gateway port>/)")
    return 0


def cmd_user_del(s: Services, args) -> int:
    s.admin.remove(args.name)
    print(f"removed {args.name} and deleted the Unix account with its home directory")
    return 0


def cmd_user_passwd(s: Services, args) -> int:
    s.admin.set_password(args.name, _read_password(args))
    print(f"password changed for {args.name} (Unix and web sign-in)")
    return 0


def cmd_user_enable(s: Services, args) -> int:
    s.admin.set_enabled(args.name, args.enable)
    print(f"{'enabled' if args.enable else 'disabled'} {args.name}")
    return 0


def cmd_user_rotate_key(s: Services, args) -> int:
    s.admin.rotate_llm_key(args.name)
    print(f"new relay key issued for {args.name}; their dsh restarts to pick it up")
    return 0


def cmd_user_list(s: Services, args) -> int:
    users = s.users.load()
    if args.names:
        for name in sorted(users):
            print(name)
        return 0
    live = (s.state_file.read() or {}).get("users", {})
    rows = [("NAME", "PORT", "ENABLED", "STATUS")]
    for name, u in sorted(users.items()):
        info = live.get(name, {})
        status = "up" if info.get("up") else ("disabled" if not u.enabled else info.get("error") or "down")
        rows.append((name, str(u.port), "yes" if u.enabled else "no", status))
    widths = [max(len(r[i]) for r in rows) for i in range(3)]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)) + "  " + r[3])
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mu-dsh", description="Multi-user DeepSeek Harness service")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("serve", help="run the service (systemd ExecStart)").set_defaults(func=cmd_serve)
    sub.add_parser("install-dsh", help="install the pinned dsh version if missing").set_defaults(func=cmd_install_dsh)
    sub.add_parser("check-config", help="validate config.toml").set_defaults(func=cmd_check_config)

    user = sub.add_parser("user", help="manage users").add_subparsers(dest="user_command", required=True)
    add = user.add_parser("add", help="create a Unix account and manage it")
    add.add_argument("name")
    add.add_argument("--password-stdin", action="store_true", help="read the password from one line of stdin")
    add.set_defaults(func=cmd_user_add)

    rm = user.add_parser("del", help="stop the user's dsh and delete their Unix account and home directory")
    rm.add_argument("name")
    rm.set_defaults(func=cmd_user_del)

    pw = user.add_parser("passwd", help="set a user's Unix (and so web sign-in) password")
    pw.add_argument("name")
    pw.add_argument("--password-stdin", action="store_true")
    pw.set_defaults(func=cmd_user_passwd)

    for verb, enable in (("enable", True), ("disable", False)):
        e = user.add_parser(verb, help=f"{verb} a user's dsh")
        e.add_argument("name")
        e.set_defaults(func=cmd_user_enable, enable=enable)

    rk = user.add_parser("rotate-key", help="issue a new relay key")
    rk.add_argument("name")
    rk.set_defaults(func=cmd_user_rotate_key)

    ls = user.add_parser("list", help="list managed users")
    ls.add_argument("--names", action="store_true", help="print only user names, one per line")
    ls.set_defaults(func=cmd_user_list)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    try:
        return args.func(build_services(Paths.from_env()), args)
    except (UserError, AccountError, ConfigError, InstallError, ProvisionError) as e:
        print(f"mu-dsh: {e}", file=sys.stderr)
        return 1
    except PermissionError as e:
        print(f"mu-dsh: {e} (run as root?)", file=sys.stderr)
        return 1
