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
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from control import config as config_mod  # noqa: E402
from control import dshenv, managed, state, supervisor  # noqa: E402
from control.accounts import Account, AccountError, Accounts  # noqa: E402
from control.admin import UserAdmin  # noqa: E402
from control.controlserver import ControlServer  # noqa: E402
from control.changes import Changes  # noqa: E402
from control.provision import Provision, Provisioner  # noqa: E402
from control.sitelayers import Layers, SiteLayers  # noqa: E402
from control.state import SessionSecret, StateFile  # noqa: E402
from control.users import User, UserError, UserStore, allocate_port  # noqa: E402
from control.workspace import WorkspaceRequests  # noqa: E402

CONFIG = textwrap.dedent(
    """
    [gateway]
    listen = "0.0.0.0:8080"
    public_url = "http://gw.example:8080/"

    [relay]
    listen = "127.0.0.1:8401"

    [dsh]
    version = "0.2.1-rc.5"

    [dsh.env]
    HTTPS_PROXY = "http://proxy.example:3128"
    no_proxy = "llm.example,.corp.example"
    NODE_EXTRA_CA_CERTS = "/etc/ssl/corp.pem"
    PIP_INDEX_URL = "https://pypi.corp.example/simple"

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

    def test_public_url_is_optional(self):
        cfg = parse(CONFIG.replace('public_url = "http://gw.example:8080/"', ""))
        self.assertEqual((cfg.gateway.public_url, cfg.public_host), ("", ""))

    def test_dsh_env(self):
        cfg = parse()
        self.assertEqual(cfg.dsh.env[0], ("HTTPS_PROXY", "http://proxy.example:3128"))
        file_env, launch_env = dshenv.split(cfg.dsh.env)
        self.assertEqual([k for k, _ in file_env], ["HTTPS_PROXY", "no_proxy", "PIP_INDEX_URL"])
        self.assertEqual(launch_env, (("NODE_EXTRA_CA_CERTS", "/etc/ssl/corp.pem"),))
        self.assertEqual(parse(CONFIG.replace("[dsh.env]", "[dsh.unused]")).dsh.env, ())

    def test_dsh_env_errors(self):
        for line, message in [
            ('HOME = "/x"', "sets this variable itself"),
            ('MUDSH_LLM_KEY = "x"', "sets this variable itself"),
            ('"BAD-NAME" = "x"', "not a valid"),
            ("FOO = 1", "must be a string"),
            ('FOO = "a\\nb"', "single line"),
            ("FOO = \"it's\"", "single quote"),
        ]:
            with self.subTest(line=line), self.assertRaisesRegex(config_mod.ConfigError, message):
                parse(CONFIG.replace("[dsh.env]\n", f"[dsh.env]\n{line}\n"))
        # Launch-only variables never go to .env, so quotes are fine there.
        parse(CONFIG.replace("[dsh.env]\n", "[dsh.env]\nNODE_OPTIONS = \"--title='x'\"\n"))

    def test_reasoning_efforts_off_without_value(self):
        cfg = parse(CONFIG.replace('max_tokens = 8192', 'max_tokens = 8192\nreasoning_efforts = { off = "", high = "high" }'))
        self.assertEqual(cfg.llm.models[1]["reasoningEfforts"], {"off": None, "high": "high"})
        self.assertIn("\"off\": null\n", managed.defaults_text(cfg))
        self.assertEqual(parse_yaml(managed.defaults_text(cfg))[0]["config"]["providers"]["mu-dsh"]["models"][1]["reasoningEfforts"],
                         {"off": None, "high": "high"})
        with self.assertRaisesRegex(config_mod.ConfigError, "reasoning_efforts.high must be a non-empty string"):
            parse(CONFIG.replace('max_tokens = 8192', 'max_tokens = 8192\nreasoning_efforts = { high = "" }'))

    def test_listen_ipv6(self):
        self.assertEqual(config_mod.Listen.parse("[::1]:80", "x"), config_mod.Listen("::1", 80))


class ManagedTest(unittest.TestCase):
    def test_layers_are_valid_yaml_for_node(self):
        """dsh parses patches with js-yaml; the emitted YAML must round-trip through a real parser."""
        parsed = parse_yaml(managed.defaults_text(parse()))
        self.assertEqual(parsed, managed.defaults_entries(parse()))
        provider = parsed[0]["config"]["providers"]["mu-dsh"]
        self.assertEqual(provider["baseURL"], "http://127.0.0.1:8401/v1")
        self.assertEqual(provider["apiKeyEnv"], "MUDSH_LLM_KEY")
        self.assertEqual(provider["compat"], {"thinkingFormat": "qwen"})
        self.assertEqual(parsed[1]["config"], {"provider": "mu-dsh", "model": "big"})
        self.assertEqual(parse_yaml(managed.policy_text()), managed.policy_entries())
        bundle = json.loads(managed.bundle_manifest())
        self.assertEqual(bundle["dsh"], {"bundle": {"patch": "cordis.patch.yml"}})

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_env_block_parses_like_node(self):
        env = (("HTTPS_PROXY", "http://u:p@proxy:3128"), ("X", 'a "b" #c $D'))
        block = managed.env_block("mudsh-k", env)
        out = subprocess.run(
            ["node", "-e", "process.stdout.write(JSON.stringify(require('node:util').parseEnv(require('fs').readFileSync(0,'utf8'))))"],
            input=block, capture_output=True, text=True, check=True,
        ).stdout
        self.assertEqual(json.loads(out), {"MUDSH_LLM_KEY": "mudsh-k", **dict(env)})

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


class ControlServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.store = UserStore(self.dir / "users.json", self.dir / "users.lock")
        self.store.add("alice", 20000)
        self.store.add("bob", 20000)
        self.store.set_enabled("bob", False)
        self.pam = FakePam()
        self.workspaces = WorkspaceRequests(Changes())
        self.server = ControlServer(
            self.dir / "control.sock", self.store, self.pam, self.workspaces, refusal_delay=0, workspace_timeout=5
        )
        self.server.start("nonexistent-group")

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.dir)

    def ask(self, raw: bytes) -> dict:
        import socket

        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(self.dir / "control.sock"))
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
        self.assertEqual(oct(os.stat(self.dir / "control.sock").st_mode & 0o777), "0o660")

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

    def test_workspace_requests_wait_for_the_daemon(self):
        import threading

        seen = []

        def daemon_loop():  # what Daemon.carry_out does, minus the supervisor
            while len(seen) < 2:
                for request in self.workspaces.take():
                    seen.append((request.user, request.action))
                    request.finish("not running" if request.action == "reset" else None)
                time.sleep(0.01)

        thread = threading.Thread(target=daemon_loop)
        thread.start()

        def ask(user, action):
            return self.ask(json.dumps({"op": "workspace", "user": user, "action": action}).encode() + b"\n")

        self.assertEqual(ask("alice", "recover"), {"ok": True})
        self.assertEqual(ask("alice", "reset"), {"ok": False, "error": "not running"})
        thread.join(5)
        self.assertEqual(seen, [("alice", "recover"), ("alice", "reset")])
        # Refused before reaching the daemon.
        self.assertFalse(ask("bob", "restart")["ok"])
        self.assertFalse(ask("root", "restart")["ok"])
        self.assertIn("unknown action", ask("alice", "format")["error"])
        self.assertEqual(self.workspaces.take(), [])

    def test_ask_reports_a_stopped_daemon(self):
        from control import controlserver

        with self.assertRaisesRegex(ConnectionError, "not running"):
            controlserver.ask(self.dir / "missing.sock", {"op": "workspace"})

    def test_malformed_requests_are_refused(self):
        for raw in (b"not json\n", b"[]\n", b'{"user": 1, "password": "right"}\n'):
            with self.subTest(raw=raw):
                self.assertEqual(self.ask(raw), {"ok": False})


# Stands in for `dsh --profile <p> [--from-default-profile <t>] --dump-default-config`, which
# creates a profile from dsh's template and, like dsh, refuses a directory that already exists.
FAKE_DSH = (
    sys.executable, "-c",
    "import json, os, sys; a = sys.argv; p = a[2]; t = a[a.index('--from-default-profile') + 1] if '--from-default-profile' in a else p;"
    "d = os.path.join(os.environ['DSH_HOME'], 'profiles', p); os.makedirs(d);"
    "json.dump({'name': 'dsh-profile-' + p, 'dsh': {'profile': {'bundles':"
    " ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-' + t]}}}, open(os.path.join(d, 'package.json'), 'w'))",
)


class UserFilesTest(unittest.TestCase):
    """Runs the real helper as the invoking user against a fake home."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        me = pwd.getpwuid(os.getuid())
        self.account = Account(me.pw_name, me.pw_uid, me.pw_gid, (me.pw_gid,), str(self.home), "/bin/sh")
        self.dsh = self.home / ".dsh"
        self.manifest = self.dsh / "profiles" / "web" / "package.json"
        self.provisioner = Provisioner()

    def tearDown(self):
        shutil.rmtree(self.home)

    def apply(self, key="mudsh-key1", env=(("HTTPS_PROXY", "http://proxy:3128"),), recovery=False, reset=False):
        self.provisioner.apply(Provision(
            account=self.account,
            env_block=managed.env_block(key, env),
            home_patch=managed.policy_text(),
            dsh=FAKE_DSH,
            env=(("DSH_HOME", str(self.dsh)), ("PATH", "/usr/bin:/bin")),
            recovery=recovery,
        ), reset=reset)

    def test_recovery_rebuilds_its_profile_and_disables_refused_env_lines(self):
        self.apply()
        web_patch = self.dsh / "profiles" / "web" / "cordis.patch.yml"
        web_patch.write_text("- id: broken\n")
        (self.dsh / ".env").write_text("FOO=1\nPATH=/evil\nexport dsh_debug=1\nHTTPS_PROXY=http://mine:1\n")
        recovery = self.dsh / "profiles" / managed.RECOVERY_PROFILE
        for _ in range(2):  # rebuilt each time, although dsh refuses an existing directory
            (recovery / "leftover").parent.mkdir(parents=True, exist_ok=True)
            (recovery / "leftover").write_text("x")
            self.apply(recovery=True)
            self.assertFalse((recovery / "leftover").exists())
        self.assertEqual(self.bundles(managed.RECOVERY_PROFILE), ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web", "mu-dsh-defaults"])
        self.assertEqual(web_patch.read_text(), "- id: broken\n", "recovery must not touch the user's settings")
        env = (self.dsh / ".env").read_text()
        self.assertIn("\nFOO=1\n", env)
        self.assertIn("# mu-dsh recovery disabled this line; dsh refuses PATH in .env: PATH=/evil\n", env)
        self.assertIn("dsh refuses dsh_debug in .env: export dsh_debug=1\n", env)
        self.assertIn("\nHTTPS_PROXY=http://mine:1\n", env, "proxies are allowed in ~/.dsh/.env")
        self.apply(recovery=True)
        self.assertEqual((self.dsh / ".env").read_text(), env, "disabling is idempotent")

    def test_reset_sets_the_web_settings_aside(self):
        self.apply()
        web_patch = self.dsh / "profiles" / "web" / "cordis.patch.yml"
        web_patch.write_text("- id: broken\n")
        self.apply(reset=True)
        self.assertEqual(web_patch.read_text(), "[]\n")
        backups = list(web_patch.parent.glob("cordis.patch.yml.bak-*"))
        self.assertEqual([b.read_text() for b in backups], ["- id: broken\n"])
        self.apply()
        self.assertEqual(web_patch.read_text(), "[]\n")

    def bundles(self, profile="web"):
        manifest = self.dsh / "profiles" / profile / "package.json"
        return json.loads(manifest.read_text())["dsh"]["profile"]["bundles"]

    def test_creates_profiles_and_lists_bundle(self):
        self.apply()
        self.assertEqual(self.bundles("web"), ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web", "mu-dsh-defaults"])
        self.assertEqual(self.bundles("headless"), ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "mu-dsh-defaults"])
        self.assertEqual(oct(os.stat(self.dsh).st_mode & 0o777), "0o700")

    def test_profiles_without_base_are_left_alone(self):
        minimal = self.dsh / "profiles" / "sdk-minimal"
        minimal.mkdir(parents=True)
        text = json.dumps({"dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-sdk-minimal"]}}})
        (minimal / "package.json").write_text(text)
        (self.dsh / "profiles" / "broken").mkdir()
        (self.dsh / "profiles" / "broken" / "package.json").write_text("{not json")
        self.apply()
        self.assertEqual((minimal / "package.json").read_text(), text)
        self.assertEqual((self.dsh / "profiles" / "broken" / "package.json").read_text(), "{not json")

    def test_bundle_goes_below_the_users_own_bundles(self):
        self.apply()
        manifest = json.loads(self.manifest.read_text())
        manifest["dsh"]["profile"]["bundles"] = ["@deepseek-ai/dsh-base", "mu-dsh-defaults", "@deepseek-ai/dsh-web", "my-bundle"]
        manifest["dependencies"] = {"my-bundle": "1.0.0"}
        self.manifest.write_text(json.dumps(manifest))
        self.apply()
        self.assertEqual(self.bundles(), ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web", "mu-dsh-defaults", "my-bundle"])
        self.assertEqual(json.loads(self.manifest.read_text())["dependencies"], {"my-bundle": "1.0.0"})

    def test_env_block_on_top_keeps_user_lines(self):
        self.dsh.mkdir()
        (self.dsh / ".env").write_text("MY_VAR=1\nHTTPS_PROXY=http://mine:8080\n")
        self.apply()
        first = (self.dsh / ".env").read_text()
        self.assertTrue(first.startswith(managed.ENV_BEGIN))
        self.assertTrue(first.endswith("MY_VAR=1\nHTTPS_PROXY=http://mine:8080\n"), "user lines must follow, so they win")
        self.assertIn("HTTPS_PROXY='http://proxy:3128'\n", first)
        self.apply()
        self.assertEqual((self.dsh / ".env").read_text(), first)
        self.apply(key="mudsh-key2", env=())
        env = (self.dsh / ".env").read_text()
        self.assertNotIn("key1", env)
        self.assertNotIn("proxy:3128", env)
        self.assertEqual(env.count(managed.ENV_BEGIN), 1)

    def test_old_block_at_the_end_moves_to_the_top(self):
        self.dsh.mkdir()
        (self.dsh / ".env").write_text(f"MY_VAR=1\n\n{managed.ENV_BEGIN}\nMUDSH_LLM_KEY=old\n{managed.ENV_END}\n")
        self.apply()
        env = (self.dsh / ".env").read_text()
        self.assertTrue(env.startswith(managed.ENV_BEGIN))
        self.assertIn("MY_VAR=1", env)
        self.assertNotIn("=old", env)

    def test_home_patch_is_policy_and_backs_up_the_users_file_once(self):
        self.dsh.mkdir()
        home_patch = self.dsh / "cordis.patch.yml"
        home_patch.write_text("- id: mine\n")
        self.apply()
        self.assertEqual(home_patch.read_text(), managed.policy_text())
        self.assertEqual((self.dsh / "cordis.patch.yml.pre-mu-dsh").read_text(), "- id: mine\n")
        home_patch.write_text("- id: mine-again\n")
        self.apply()
        self.assertEqual(home_patch.read_text(), managed.policy_text())
        self.assertEqual((self.dsh / "cordis.patch.yml.pre-mu-dsh").read_text(), "- id: mine\n")


class SiteLayersTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()) / "dsh"
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root.parent)

    def test_writes_bundle(self):
        SiteLayers(self.root).write(parse())
        bundle = self.root / "node_modules" / "mu-dsh-defaults"
        self.assertEqual(json.loads((bundle / "package.json").read_text())["name"], "mu-dsh-defaults")
        self.assertEqual((bundle / "cordis.patch.yml").read_text(), managed.defaults_text(parse()))
        for path in (self.root, bundle.parent, bundle, bundle / "package.json", bundle / "cordis.patch.yml"):
            self.assertTrue(os.stat(path).st_mode & 0o004, f"{path} must be world-readable")

    def test_digest_follows_content(self):
        sites = SiteLayers(self.root)
        first = sites.write(parse()).digest
        self.assertEqual(sites.write(parse()).digest, first)
        self.assertNotEqual(sites.write(parse(CONFIG.replace('default_model = "big"', 'default_model = "small"'))).digest, first)


class SpecBuilderTest(unittest.TestCase):
    class FakeHostNames:
        def authorities(self):
            return ["10.0.0.5", "gw"]

    def build(self, cfg, mode="normal"):
        from control.dshinstall import DshInstaller

        me = pwd.getpwuid(os.getuid())
        account = Account("alice", me.pw_uid, me.pw_gid, (), "/home/alice", "/bin/bash")
        builder = supervisor.SpecBuilder(DshInstaller(Path("/opt/dsh"), Path("/tmp")), self.FakeHostNames())
        return builder.build(cfg, User("alice", 20000, "k"), account, "/usr/bin/node", Layers(digest="d"), mode)

    def test_recovery_runs_the_recovery_profile_from_dsh_home(self):
        normal = self.build(parse())
        recovery = self.build(parse(), mode="recovery")
        self.assertEqual(normal.cwd, "/home/alice")
        self.assertEqual(recovery.argv[2:4], ("--profile", managed.RECOVERY_PROFILE))
        self.assertEqual(recovery.cwd, "/home/alice/.dsh")
        self.assertTrue(recovery.provision.recovery)
        self.assertNotEqual(normal, recovery, "switching modes must restart dsh")

    def test_runs_the_web_profile_with_policy_in_the_home_patch(self):
        spec = self.build(parse())
        self.assertEqual(spec.argv[2:4], ("--profile", "web"))
        self.assertNotIn("--patch", spec.argv)
        self.assertEqual(spec.provision.home_patch, managed.policy_text())
        self.assertEqual(spec.provision.dsh, spec.argv[:2])

    def test_env_goes_to_dotenv_or_launch_environment(self):
        spec = self.build(parse())
        env = dict(spec.env)
        self.assertEqual(env["NODE_EXTRA_CA_CERTS"], "/etc/ssl/corp.pem")
        self.assertEqual(env["DSH_HOME"], "/home/alice/.dsh")
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertIn("HTTPS_PROXY='http://proxy.example:3128'", spec.provision.env_block)
        self.assertIn("MUDSH_LLM_KEY=k\n", spec.provision.env_block)
        self.assertNotIn("NODE_EXTRA_CA_CERTS", spec.provision.env_block)

    def test_public_url_sets_one_trusted_host(self):
        argv = self.build(parse()).argv
        self.assertIn("--public-url", argv)
        self.assertEqual(argv[argv.index("--trusted-host") + 1], "gw.example")
        self.assertEqual(argv.count("--trusted-host"), 1)

    def test_without_public_url_trusts_own_names(self):
        argv = self.build(parse(CONFIG.replace('public_url = "http://gw.example:8080/"', ""))).argv
        self.assertNotIn("--public-url", argv)
        self.assertEqual([argv[i + 1] for i, a in enumerate(argv) if a == "--trusted-host"], ["10.0.0.5", "gw"])


class FakeProc:
    """Stands in for subprocess.Popen: prints the dsh URL line, then runs until ended."""

    _next_pid = 1000

    def __init__(self, token: str, lines: list[str] | None = None):
        FakeProc._next_pid += 1
        self.pid = FakeProc._next_pid
        self.returncode = None
        if lines is None:
            lines = [f"dsh web: http://gw/u/alice/?token={token}"]
        self.stdout = [f"{line}\n".encode() for line in lines]

    def poll(self):
        return self.returncode


class FakeLauncher:
    def __init__(self):
        self.started: list[FakeProc] = []
        self.stopped: list[FakeProc] = []
        self.fail_next = False
        self.output: list[str] | None = None
        self.resets: list[bool] = []

    def start(self, spec, reset=False):
        self.resets.append(reset)
        if self.fail_next:
            self.fail_next = False
            raise OSError("exec failed")
        proc = FakeProc(token=f"tok{len(self.started)}", lines=self.output)
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
        provision = Provision(account=self.account, env_block=managed.env_block(key), home_patch="", dsh=(), env=())
        return supervisor.Spec(provision=provision, argv=("dsh",), cwd="/tmp", layers="d")

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
        self.assertEqual(self.sup.snapshot()["alice"], {"up": True, "token": "tok0", "error": None, "mode": "normal"})
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
        self.assertEqual(self.sup.snapshot()["alice"], {"up": True, "token": "tok3", "error": None, "mode": "normal"})

    def test_crash_reports_dsh_error(self):
        self.launcher.output = [
            "file:///opt/dsh/lib/index.js:3998",
            "Error: dsh: failed to parse overlay /home/alice/.dsh/profiles/web/cordis.patch.yml: YAMLException: bad",
            " 2 |   config: [oops",
            "    at parsePatchList (file:///opt/dsh/lib/index.js:3998:9)",
            "",
            "Node.js v26.13.0",
        ]
        self.sup.apply({"alice": self.spec()})
        self.sup.tick()
        self.launcher.started[-1].returncode = 1
        self.now += 1
        self.sup.tick()
        error = self.sup.snapshot()["alice"]["error"]
        self.assertTrue(error.startswith("exited with status 1 after 1s:\nError: dsh: failed to parse overlay"), error)
        self.assertIn("config: [oops", error)
        self.assertNotIn("parsePatchList", error)

    def test_error_summary_without_error_line_keeps_the_tail(self):
        lines = [f"line {i}" for i in range(30)]
        self.assertEqual(supervisor.error_summary(lines).splitlines(), lines[-supervisor.ERROR_LINES:])

    def test_restart_skips_backoff_and_can_reset_once(self):
        self.sup.apply({"alice": self.spec()})
        self.sup.tick()
        self.settle()
        self.launcher.started[-1].returncode = 1
        self.now += 1
        self.sup.tick()  # crashed: next start backs off
        self.assertEqual(len(self.launcher.started), 1)
        self.sup.restart("alice", reset=True)
        self.assertIsNone(self.sup.snapshot()["alice"]["error"])
        self.sup.tick()
        self.settle()
        self.assertEqual(len(self.launcher.started), 2, "restart starts at once")
        self.sup.restart("alice")
        self.assertEqual(self.launcher.stopped[-1], self.launcher.started[1], "restart stops the running dsh")
        self.sup.tick()
        self.assertEqual(self.launcher.resets, [False, True, False])
        self.assertEqual(self.sup.snapshot()["alice"]["mode"], "normal")
        with self.assertRaises(KeyError):
            self.sup.restart("nobody")

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
        status = {"alice": {"up": True, "token": "t", "error": None, "mode": "recovery"}}
        payload = state.render(cfg, users, "sec", "/run/mu-dsh/control.sock", status)
        self.assertEqual(
            payload["users"]["alice"],
            {"port": 20000, "llm_key": "k", "enabled": True, "up": True, "token": "t", "error": None, "mode": "recovery"},
        )
        self.assertEqual(payload["control_socket"], "/run/mu-dsh/control.sock")
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
