"""Host-side unit tests for the control plane. Run: python3 -m unittest discover -s tests/unit"""

from __future__ import annotations

import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from control import config as config_mod  # noqa: E402
from control import managed, state, supervisor  # noqa: E402
from control.accounts import Account, AccountError, Accounts  # noqa: E402
from control.admin import UserAdmin  # noqa: E402
from control.authserver import AuthServer  # noqa: E402
from control.changes import Changes  # noqa: E402
from control.provision import Provisioner  # noqa: E402
from control.state import SessionSecret, StateFile  # noqa: E402
from control.users import User, UserError, UserStore, allocate_port  # noqa: E402

CONFIG = textwrap.dedent(
    """
    [gateway]
    listen = "0.0.0.0:8080"
    public_url = "http://gw.example:8080/"

    [relay]
    listen = "127.0.0.1:8401"

    [dsh]
    version = "0.2.1-rc.5"

    [llm]
    base_url = "https://llm.example/v1"
    api_key = "sk-real"
    default_model = "big"

    [llm.compat]
    thinkingFormat = "qwen"

    [[llm.models]]
    id = "small"
    context_window = 32768

    [[llm.models]]
    id = "big"
    name = "Big Model"
    context_window = 131072
    max_tokens = 8192
    input = ["text", "image"]
    """
)


def parse(text: str = CONFIG) -> config_mod.Config:
    import tomllib

    return config_mod.parse(tomllib.loads(text))


class ConfigTest(unittest.TestCase):
    def test_parses_and_normalizes(self):
        cfg = parse()
        self.assertEqual(cfg.gateway.public_url, "http://gw.example:8080")
        self.assertEqual(cfg.public_host, "gw.example")
        self.assertEqual(cfg.relay.base_url, "http://127.0.0.1:8401/v1")
        self.assertEqual(cfg.dsh.port_base, 20000)
        self.assertEqual(cfg.llm.provider_id, "mu-dsh")
        self.assertEqual(cfg.llm.models[1], {"id": "big", "name": "Big Model", "contextWindow": 131072, "maxTokens": 8192, "input": ["text", "image"]})

    def test_rejects_bad_values(self):
        cases = {
            'public_url = "http://gw.example:8080/"': 'public_url = "http://gw.example/sub"',
            'default_model = "big"': 'default_model = "missing"',
            'listen = "0.0.0.0:8080"': 'listen = "8080"',
            'base_url = "https://llm.example/v1"': 'base_url = "llm.example"',
        }
        for old, new in cases.items():
            with self.subTest(new=new), self.assertRaises(config_mod.ConfigError):
                parse(CONFIG.replace(old, new))

    def test_listen_ipv6(self):
        self.assertEqual(config_mod.Listen.parse("[::1]:80", "x"), config_mod.Listen("::1", 80))


class ManagedTest(unittest.TestCase):
    def test_patch_is_valid_yaml_for_node(self):
        """dsh parses the patch with js-yaml; the emitted YAML must round-trip through a real parser."""
        text = managed.patch_text(parse())
        self.assertTrue(text.startswith(managed.PATCH_MARKER))
        parsed = parse_yaml(text)
        self.assertEqual(parsed, managed.patch_entries(parse()))
        provider = parsed[0]["config"]["providers"]["mu-dsh"]
        self.assertEqual(provider["baseURL"], "http://127.0.0.1:8401/v1")
        self.assertEqual(provider["apiKeyEnv"], "MUDSH_LLM_KEY")
        self.assertEqual(provider["compat"], {"thinkingFormat": "qwen"})

    def test_yaml_quoting(self):
        value = [{"a: b": "x\n\"y\"", "n": None, "t": True, "e": [], "d": {}, "l": [1, "two", {"k": "v"}]}]
        self.assertEqual(parse_yaml(managed.to_yaml(value)), value)


def parse_yaml(text: str):
    """Parse YAML with js-yaml from the installed dsh if available, else PyYAML."""
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text)
    except ImportError:
        pass
    js_yaml = os.environ.get("MU_DSH_TEST_JS_YAML")
    if not js_yaml:
        raise unittest.SkipTest("no YAML parser available (install PyYAML or set MU_DSH_TEST_JS_YAML)")
    out = subprocess.run(
        ["node", "-e", f"const y=require({json.dumps(js_yaml)});let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(y.load(s))))"],
        input=text, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


class UsersTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.store = UserStore(self.dir / "users.json", self.dir / "users.lock")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_add_allocates_ports_and_persists(self):
        u = self.store.add("alice", 20000)
        self.assertEqual((u.port, self.store.add("bob", 20000).port), (20000, 20001))
        self.assertTrue(u.llm_key.startswith("mudsh-"))
        self.assertEqual(oct(os.stat(self.dir / "users.json").st_mode & 0o777), "0o600")
        with self.assertRaises(UserError):
            self.store.add("alice", 20000)
        self.store.set_enabled("alice", False)
        self.assertFalse(self.store.load()["alice"].enabled)
        self.store.remove("alice")
        self.assertEqual(list(self.store.load()), ["bob"])

    def test_ignores_fields_from_older_versions(self):
        (self.dir / "users.json").write_text(json.dumps(
            {"version": 1, "users": {"alice": {"port": 20000, "llm_key": "k", "enabled": True, "password_hash": "old"}}}
        ))
        self.assertEqual(self.store.load()["alice"], User("alice", 20000, "k", True))

    def test_allocate_port_fills_gaps(self):
        users = {n: User(n, p, "") for n, p in [("a", 20000), ("b", 20002)]}
        self.assertEqual(allocate_port(users, 20000), 20001)


class FakeRunner:
    """Records shadow-utils commands instead of running them."""

    def __init__(self, codes: dict[str, int] | None = None):
        self.calls: list[tuple[list[str], str | None]] = []
        self.codes = codes or {}

    def __call__(self, cmd, input=None, **_kw):
        self.calls.append((cmd, input))
        return subprocess.CompletedProcess(cmd, self.codes.get(cmd[0], 0), "", "boom")

    @property
    def commands(self) -> list[str]:
        return [c[0] for c, _ in self.calls]


class AccountsTest(unittest.TestCase):
    def test_create_runs_useradd_then_chpasswd(self):
        run = FakeRunner()
        Accounts(run=run).create("newuser-xyz", "s3cret pass")
        self.assertEqual(run.calls[0][0], ["useradd", "--create-home", "--shell", "/bin/bash", "--comment", "mu-dsh user", "newuser-xyz"])
        self.assertEqual(run.calls[1], (["chpasswd"], "newuser-xyz:s3cret pass\n"))

    def test_create_refuses_existing_accounts(self):
        run = FakeRunner()
        me = pwd.getpwuid(os.getuid()).pw_name
        for name in (me, "root"):
            with self.subTest(name=name), self.assertRaisesRegex(AccountError, "already exists"):
                Accounts(run=run).create(name, "pw")
        self.assertEqual(run.calls, [])

    def test_create_validates_input(self):
        accounts = Accounts(run=FakeRunner())
        for name, password in (("../evil", "pw"), ("Bob", "pw"), ("newuser-xyz", ""), ("newuser-xyz", "a\nb")):
            with self.subTest(name=name, password=password), self.assertRaises(AccountError):
                accounts.create(name, password)

    def test_create_rolls_back_when_password_fails(self):
        run = FakeRunner({"chpasswd": 1})
        with self.assertRaisesRegex(AccountError, "chpasswd failed"):
            Accounts(run=run).create("newuser-xyz", "pw")
        self.assertEqual(run.commands, ["useradd", "chpasswd", "userdel"])

    def test_delete_skips_missing_accounts_and_refuses_root(self):
        run = FakeRunner()
        Accounts(run=run).delete("no-such-user-xyz")
        self.assertEqual(run.calls, [])
        with self.assertRaises(AccountError):
            Accounts(run=run).delete("root")
        self.assertEqual(run.calls, [])


class FakeAccounts:
    def __init__(self):
        self.log: list[tuple] = []

    def create(self, name, password):
        self.log.append(("create", name, password))

    def delete(self, name):
        self.log.append(("delete", name))

    def set_password(self, name, password):
        self.log.append(("set_password", name, password))


class FakePidFile:
    def __init__(self, running: bool):
        self.running = running
        self.reloads = 0

    def request_reload(self) -> bool:
        self.reloads += 1
        return self.running


class UserAdminTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.store = UserStore(self.dir / "users.json", self.dir / "users.lock")
        self.accounts = FakeAccounts()
        self.state_file = StateFile(self.dir / "gateway.json")
        self.said: list[str] = []

    def tearDown(self):
        shutil.rmtree(self.dir)

    def admin(self, running: bool = True) -> UserAdmin:
        self.pid = FakePidFile(running)
        return UserAdmin(self.store, self.accounts, self.pid, self.state_file, say=self.said.append, sleep=lambda _: None)

    def test_add_creates_account_and_entry(self):
        admin = self.admin()
        user = admin.add("alice", "pw", 20000)
        self.assertEqual(self.accounts.log, [("create", "alice", "pw")])
        self.assertEqual(self.store.load()["alice"], user)
        self.assertEqual(self.pid.reloads, 1)
        with self.assertRaisesRegex(UserError, "already managed"):
            admin.add("alice", "pw", 20000)
        self.assertEqual(len(self.accounts.log), 1, "no second account for a managed name")

    def test_remove_waits_for_daemon_then_deletes_account(self):
        admin = self.admin()
        admin.add("alice", "pw", 20000)
        self.state_file.write({"users": {}}, "nonexistent-group")  # the daemon already dropped alice
        admin.remove("alice")
        self.assertEqual(self.accounts.log[-1], ("delete", "alice"))
        self.assertNotIn("alice", self.store.load())

    def test_remove_gives_up_waiting(self):
        admin = self.admin()
        admin.release_timeout = 1.0
        admin.add("alice", "pw", 20000)
        self.state_file.write({"users": {"alice": {}}}, "nonexistent-group")  # daemon never releases
        admin.remove("alice")
        self.assertEqual(self.accounts.log[-1], ("delete", "alice"))
        self.assertTrue(any("did not release" in line for line in self.said))

    def test_password_change_needs_no_reload(self):
        admin = self.admin()
        admin.add("alice", "pw", 20000)
        admin.set_password("alice", "pw2")
        self.assertEqual(self.accounts.log[-1], ("set_password", "alice", "pw2"))
        self.assertEqual(self.pid.reloads, 1)
        with self.assertRaises(UserError):
            admin.set_password("bob", "pw")


class FakePam:
    def __init__(self):
        self.checked: list[str] = []
        self.changed: list[tuple[str, str]] = []

    def check(self, user, password):
        self.checked.append(user)
        return password == "right"

    def change(self, user, current, new):
        if len(new) < 8:
            return "The password is shorter than 8 characters"
        self.changed.append((user, new))
        return None


class AuthServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.store = UserStore(self.dir / "users.json", self.dir / "users.lock")
        self.store.add("alice", 20000)
        self.store.add("bob", 20000)
        self.store.set_enabled("bob", False)
        self.pam = FakePam()
        self.server = AuthServer(self.dir / "auth.sock", self.store, self.pam, refusal_delay=0)
        self.server.start("nonexistent-group")

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.dir)

    def ask(self, raw: bytes) -> dict:
        import socket

        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(self.dir / "auth.sock"))
            s.sendall(raw)
            return json.loads(s.makefile().readline())

    def test_only_managed_enabled_users_reach_pam(self):
        def ask(user, password):
            return self.ask(json.dumps({"user": user, "password": password}).encode() + b"\n")["ok"]

        self.assertTrue(ask("alice", "right"))
        self.assertFalse(ask("alice", "wrong"))
        self.assertFalse(ask("bob", "right"))  # disabled
        self.assertFalse(ask("root", "right"))  # not managed
        self.assertFalse(ask("alice", ""))
        self.assertEqual(self.pam.checked, ["alice", "alice"])
        self.assertEqual(oct(os.stat(self.dir / "auth.sock").st_mode & 0o777), "0o660")

    def test_change_password(self):
        def change(user, current, new):
            raw = json.dumps({"op": "change_password", "user": user, "password": current, "new_password": new})
            return self.ask(raw.encode() + b"\n")

        self.assertEqual(change("alice", "wrong", "new-password"), {"ok": False, "error": "The current password is wrong."})
        # PAM's own complaint reaches the user; mu-dsh adds no rules of its own.
        self.assertEqual(change("alice", "right", "short"), {"ok": False, "error": "The password is shorter than 8 characters"})
        self.assertIn("differ", change("alice", "right", "right")["error"])
        self.assertIn("one line", change("alice", "right", "two\nlines")["error"])
        self.assertFalse(change("bob", "right", "new-password")["ok"])  # disabled
        self.assertEqual(self.pam.changed, [])
        self.assertEqual(change("alice", "right", "new-password"), {"ok": True})
        self.assertEqual(self.pam.changed, [("alice", "new-password")])

    def test_malformed_requests_are_refused(self):
        for raw in (b"not json\n", b"[]\n", b'{"user": 1, "password": "right"}\n'):
            with self.subTest(raw=raw):
                self.assertEqual(self.ask(raw), {"ok": False})


class UserFilesTest(unittest.TestCase):
    """Runs the real helper as the invoking user against a fake home."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        me = pwd.getpwuid(os.getuid())
        self.account = Account(me.pw_name, me.pw_uid, me.pw_gid, (me.pw_gid,), str(self.home), "/bin/sh")
        self.dsh = self.home / ".dsh"
        self.provisioner = Provisioner()

    def tearDown(self):
        shutil.rmtree(self.home)

    def test_apply_is_idempotent_and_preserves_user_lines(self):
        self.dsh.mkdir()
        (self.dsh / ".env").write_text("MY_VAR=1\n")
        (self.dsh / "cordis.patch.yml").write_text("- id: mine\n")
        patch = managed.patch_text(parse())
        self.provisioner.apply(self.account, patch, "mudsh-key1")
        first = (self.dsh / ".env").read_text()
        self.provisioner.apply(self.account, patch, "mudsh-key1")
        self.assertEqual((self.dsh / ".env").read_text(), first)
        self.assertIn("MY_VAR=1\n", first)
        self.assertIn("MUDSH_LLM_KEY=mudsh-key1\n", first)
        self.assertEqual((self.dsh / "cordis.patch.yml").read_text(), patch)
        self.assertEqual((self.dsh / "cordis.patch.yml.pre-mu-dsh").read_text(), "- id: mine\n")
        self.assertEqual(oct(os.stat(self.dsh).st_mode & 0o777), "0o700")

        self.provisioner.apply(self.account, patch, "mudsh-key2")
        env = (self.dsh / ".env").read_text()
        self.assertNotIn("key1", env)
        self.assertEqual(env.count(managed.ENV_BEGIN), 1)

    def test_creates_dsh_home(self):
        self.provisioner.apply(self.account, "x", "k")
        self.assertTrue((self.dsh / ".env").exists())


class FakeProc:
    """Stands in for subprocess.Popen: prints the dsh URL line, then runs until ended."""

    _next_pid = 1000

    def __init__(self, token: str):
        FakeProc._next_pid += 1
        self.pid = FakeProc._next_pid
        self.returncode = None
        self.stdout = [f"dsh web: http://gw/u/alice/?token={token}\n".encode()]

    def poll(self):
        return self.returncode


class FakeLauncher:
    def __init__(self):
        self.started: list[FakeProc] = []
        self.stopped: list[FakeProc] = []
        self.fail_next = False

    def start(self, spec):
        if self.fail_next:
            self.fail_next = False
            raise OSError("exec failed")
        proc = FakeProc(token=f"tok{len(self.started)}")
        self.started.append(proc)
        return proc

    def stop(self, procs, timeout=0):
        for proc in procs:
            proc.returncode = -15
            self.stopped.append(proc)


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.launcher = FakeLauncher()
        self.changes = Changes()
        self.sup = supervisor.Supervisor(self.launcher, self.changes, clock=lambda: self.now)
        me = pwd.getpwuid(os.getuid())
        self.account = Account("alice", me.pw_uid, me.pw_gid, (), "/tmp", "/bin/sh")

    def spec(self, key: str = "k") -> supervisor.Spec:
        return supervisor.Spec(account=self.account, argv=("dsh",), env=(), patch="", llm_key=key)

    def settle(self) -> None:
        for inst in self.sup.instances.values():
            if inst.reader is not None:
                inst.reader.join(timeout=5)

    def test_token_from_line(self):
        self.assertEqual(supervisor.token_from_line("dsh web: http://gw/u/alice/?token=abc_-1"), "abc_-1")
        self.assertIsNone(supervisor.token_from_line("dsh web: http://gw/u/alice/"))
        self.assertIsNone(supervisor.token_from_line("something else"))

    def test_start_captures_token(self):
        self.sup.apply({"alice": self.spec()})
        self.sup.tick()
        self.settle()
        self.assertEqual(self.sup.snapshot()["alice"], {"up": True, "token": "tok0", "error": None})
        self.assertTrue(self.changes.take())

    def test_crash_restarts_with_backoff(self):
        self.sup.apply({"alice": self.spec()})
        self.sup.tick()
        self.settle()
        for expected_delay in (1.0, 2.0, 4.0):
            self.launcher.started[-1].returncode = 1  # crash soon after start
            self.now += 5
            started = len(self.launcher.started)
            self.sup.tick()
            self.assertFalse(self.sup.snapshot()["alice"]["up"])
            self.assertIn("exited with status 1", self.sup.snapshot()["alice"]["error"])
            self.now += expected_delay - 0.1
            self.sup.tick()
            self.assertEqual(len(self.launcher.started), started, "restarted before its backoff elapsed")
            self.now += 0.1
            self.sup.tick()
            self.settle()
            self.assertEqual(len(self.launcher.started), started + 1)
        self.assertEqual(self.sup.snapshot()["alice"], {"up": True, "token": "tok3", "error": None})

    def test_exec_failure_backs_off(self):
        self.launcher.fail_next = True
        self.sup.apply({"alice": self.spec()})
        self.sup.tick()
        self.assertEqual(self.sup.snapshot()["alice"]["error"], "exec failed")
        self.sup.tick()
        self.assertEqual(self.launcher.started, [])
        self.now += 1
        self.sup.tick()
        self.assertEqual(len(self.launcher.started), 1)

    def test_changed_spec_restarts_and_removed_user_stops(self):
        self.sup.apply({"alice": self.spec("k1")})
        self.sup.tick()
        first = self.launcher.started[0]
        self.sup.apply({"alice": self.spec("k1")})
        self.assertEqual(self.launcher.stopped, [], "an unchanged spec must not restart")
        self.sup.apply({"alice": self.spec("k2")})
        self.assertEqual(self.launcher.stopped, [first])
        self.sup.tick()
        self.assertEqual(len(self.launcher.started), 2)
        self.sup.apply({})
        self.assertEqual(self.launcher.stopped[-1], self.launcher.started[1])
        self.assertEqual(self.sup.snapshot(), {})


class StateTest(unittest.TestCase):
    def test_render_and_write(self):
        cfg = parse()
        users = {"alice": User("alice", 20000, "k")}
        payload = state.render(cfg, users, "sec", "/run/mu-dsh/auth.sock", {"alice": {"up": True, "token": "t", "error": None}})
        self.assertEqual(payload["users"]["alice"], {"port": 20000, "llm_key": "k", "enabled": True, "up": True, "token": "t", "error": None})
        self.assertEqual(payload["auth_socket"], "/run/mu-dsh/auth.sock")
        self.assertEqual(payload["relay"]["upstream"], "https://llm.example/v1")
        with tempfile.TemporaryDirectory() as d:
            state_file = StateFile(Path(d) / "gateway.json")
            state_file.write(payload, "nonexistent-group")
            self.assertEqual(state_file.read(), payload)
            self.assertEqual(oct(os.stat(state_file.path).st_mode & 0o777), "0o640")
            secret = SessionSecret(Path(d) / "secret")
            self.assertEqual(secret.get(), secret.get())


if __name__ == "__main__":
    unittest.main()
