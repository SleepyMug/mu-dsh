"""End-to-end system tests: install mu-dsh in a fresh VM and exercise it.

The tests share one VM and run in name order (test_01, test_02, ...); each
builds on the state the previous ones left. Run with ``tests/vm/vm.py test``.
"""

from __future__ import annotations

import base64
import http.client
import io
import json
import os
import re
import shlex
import socket
import sys
import time
import unittest
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vmlib  # noqa: E402

PUBLIC_HOST = "gw.test"
PASSWORDS = {"alice": "alice-pass-1", "bob": "bob-pass-1"}
REAL_KEY = "real-upstream-key"
FAKE_REPLY = "Hello from the fake LLM."

CONFIG = """\
[gateway]
listen = "0.0.0.0:8080"
public_url = "http://{host}:{port}"

[relay]
listen = "127.0.0.1:8401"

[dsh]
version = "{dsh_version}"
port_base = 20000

[dsh.env]
# Unreachable on purpose: dsh never proxies loopback, so model calls via the relay still work.
HTTPS_PROXY = "http://proxy.invalid:3128"
MUDSH_TEST_VAR = "from-config"
NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt"

[llm]
base_url = "http://127.0.0.1:9000/v1"
api_key = "{real_key}"
default_model = "test-model"

[[llm.models]]
id = "test-model"
name = "Test Model"
context_window = 131072
max_tokens = 4096

[[llm.models]]
id = "other-model"
context_window = 32768
"""

OVERRIDE_DEFAULT_MODEL = """\
- id: agent-default-model
  config:
    provider: mu-dsh
    model: other-model
- id: session-telemetry-otel
  config:
    mode: ENABLED
"""


def wait_until(predicate, timeout: float = 120, interval: float = 1.0, what: str = "condition"):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
        except Exception as e:  # keep polling through transient failures
            last = e
        else:
            if last:
                return last
        time.sleep(interval)
    raise AssertionError(f"timed out after {timeout:.0f}s waiting for {what} (last: {last!r})")


@dataclass
class Response:
    status: int
    headers: list[tuple[str, str]]
    body: bytes

    def header(self, name: str) -> str | None:
        for k, v in self.headers:
            if k.lower() == name.lower():
                return v
        return None

    def cookies(self) -> list[str]:
        return [v for k, v in self.headers if k.lower() == "set-cookie"]


@dataclass
class Browser:
    """A minimal browser: path-scoped cookie jar, explicit Host header, manual redirects."""

    port: int
    host: str
    jar: dict[tuple[str, str], str] = field(default_factory=dict)  # (name, path) -> value

    @property
    def authority(self) -> str:
        return f"{self.host}:{self.port}"

    def cookie_header(self, path: str) -> str:
        pairs = [(n, v, p) for (n, p), v in self.jar.items() if path.startswith(p)]
        pairs.sort(key=lambda t: -len(t[2]))  # longest path first, like browsers
        return "; ".join(f"{n}={v}" for n, v, _ in pairs)

    def store(self, set_cookie: str) -> None:
        parts = [p.strip() for p in set_cookie.split(";")]
        name, _, value = parts[0].partition("=")
        attrs = {k.lower(): v for k, _, v in (p.partition("=") for p in parts[1:])}
        path = attrs.get("path", "/")
        if attrs.get("max-age") == "0":
            self.jar.pop((name, path), None)
        else:
            self.jar[(name, path)] = value

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> Response:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        all_headers = {"Host": self.authority, "Accept": "text/html", **(headers or {})}
        cookie = self.cookie_header(path.split("?")[0])
        if cookie:
            all_headers["Cookie"] = cookie
        conn.request(method, path, body=body, headers=all_headers)
        resp = conn.getresponse()
        result = Response(resp.status, resp.getheaders(), resp.read())
        conn.close()
        for c in result.cookies():
            self.store(c)
        return result

    def get(self, path: str) -> Response:
        return self.request("GET", path)

    def stream(self, path: str) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        """Start a GET whose body the caller reads as it arrives; the caller closes the connection."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"Host": self.authority}
        cookie = self.cookie_header(path.split("?")[0])
        if cookie:
            headers["Cookie"] = cookie
        conn.request("GET", path, headers=headers)
        return conn, conn.getresponse()

    def follow(self, path: str, limit: int = 10) -> list[Response]:
        chain = []
        for _ in range(limit):
            resp = self.get(path)
            chain.append(resp)
            location = resp.header("location")
            if resp.status not in (301, 302, 303, 307, 308) or location is None:
                return chain
            if location.startswith("./"):
                path = path.split("?")[0].rsplit("/", 1)[0] + "/" + location[2:]
            elif location.startswith("/"):
                path = location
            else:
                raise AssertionError(f"unexpected redirect target {location!r}")
        raise AssertionError(f"too many redirects from {path}")

    def login(self, user: str, password: str) -> Response:
        body = f"username={user}&password={password}".encode()
        return self.request("POST", "/login", body, {"Content-Type": "application/x-www-form-urlencoded"})

    def websocket_status(self, path: str) -> str:
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {self.authority}",
            f"Origin: http://{self.authority}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        cookie = self.cookie_header(path)
        if cookie:
            lines.append(f"Cookie: {cookie}")
        with socket.create_connection(("127.0.0.1", self.port), timeout=30) as s:
            s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            data = b""
            while b"\r\n" not in data:
                chunk = s.recv(1024)
                if not chunk:
                    break
                data += chunk
        return data.split(b"\r\n", 1)[0].decode()


class SystemTest(unittest.TestCase):
    vm: vmlib.VM

    @classmethod
    def setUpClass(cls):
        cls.vm = vmlib.boot_fresh()
        cls.vm.put_repo("/root/mu-dsh")

    @classmethod
    def tearDownClass(cls):
        if os.environ.get("MU_DSH_VM_KEEP"):
            print(f"\nVM left running (ssh port {cls.vm.ssh_port}); stop it with tests/vm/vm.py down", file=sys.stderr)
        else:
            cls.vm.kill()  # -snapshot: nothing worth a clean shutdown

    # -- helpers ------------------------------------------------------------

    def setUp(self):
        result = self._outcome.result
        self._problems_before = len(result.failures) + len(result.errors)

    def tearDown(self):
        result = self._outcome.result
        if len(result.failures) + len(result.errors) > self._problems_before:
            out = self.vm.ssh(
                "journalctl --no-pager -n 80 -u mu-dsh -u mu-dsh-gateway; cat /run/mu-dsh/gateway.json 2>/dev/null"
                " | python3 -c 'import json,sys; d=json.load(sys.stdin); print({u: (v[\"up\"], v[\"error\"]) for u, v in d[\"users\"].items()})'",
                check=False,
            )
            print(f"\n--- guest diagnostics ---\n{out.stdout}{out.stderr}", file=sys.stderr)

    def sh(self, command: str, **kw):
        return self.vm.ssh(command, **kw)

    def browser(self) -> Browser:
        return Browser(self.vm.http_port, PUBLIC_HOST)

    def gateway_state(self) -> dict:
        return json.loads(self.sh("cat /run/mu-dsh/gateway.json").stdout)

    def wait_state(self, predicate, what: str, timeout: float = 180) -> dict:
        """Poll gateway.json until predicate(state) holds; return that state."""

        def check():
            state = self.gateway_state()
            return state if predicate(state) else None

        return wait_until(check, timeout=timeout, what=what)

    def wait_up(self, *users: str, timeout: float = 180) -> dict:
        return self.wait_state(
            lambda s: all(s["users"].get(u, {}).get("up") for u in users), f"{', '.join(users)} up", timeout
        )

    def dsh_pid(self, port: int) -> int | None:
        out = self.sh(f"ss -ltnpH 'sport = :{port}'", check=False).stdout
        if "pid=" not in out:
            return None
        return int(out.split("pid=")[1].split(",")[0])

    def fake_llm_requests(self) -> list[dict]:
        return json.loads(self.sh("curl -sf http://127.0.0.1:9000/requests").stdout)

    def relay_status(self, key: str) -> str:
        return self.sh(
            f"curl -s -o /dev/null -w '%{{http_code}}' -H 'Authorization: Bearer {key}' http://127.0.0.1:8401/v1/models",
            check=False,
        ).stdout

    def signed_in(self, user: str) -> Browser:
        b = self.browser()
        self.assertEqual(b.login(user, PASSWORDS[user]).status, 303)
        chain = b.follow(f"/u/{user}/")
        self.assertEqual(chain[-1].status, 200, [(r.status, r.header("location")) for r in chain])
        return b

    # -- tests --------------------------------------------------------------

    def test_01_install(self):
        out = self.sh("cd /root/mu-dsh && ./install.sh", timeout=300)
        self.assertIn("Next steps", out.stdout)
        for path in ["/opt/mu-dsh/control/cli.py", "/opt/mu-dsh/gateway/src/main.ts", "/usr/local/bin/mu-dsh",
                     "/etc/systemd/system/mu-dsh.service", "/etc/systemd/system/mu-dsh-gateway.service"]:
            self.sh(f"test -e {path}")
        self.assertEqual(self.sh("stat -c %a /etc/mu-dsh/config.toml").stdout.strip(), "600")
        self.assertNotIn("@NODE@", self.sh("cat /etc/systemd/system/mu-dsh-gateway.service").stdout)
        self.sh("id mu-dsh")

    def test_02_configure_and_start(self):
        config = CONFIG.format(host=PUBLIC_HOST, port=self.vm.http_port, dsh_version=vmlib.DSH_VERSION, real_key=REAL_KEY)
        self.sh("cat > /etc/mu-dsh/config.toml", input=config)
        self.assertIn("OK", self.sh("mu-dsh check-config").stdout)
        self.sh(
            "systemd-run --unit=fake-llm --property=Restart=always "
            f"python3 /root/mu-dsh/tests/vm/fake_llm.py --port 9000 --model test-model --reply {shlex.quote(FAKE_REPLY)}"
        )
        self.sh("systemctl enable --now mu-dsh", timeout=900)  # first start installs dsh
        wait_until(lambda: self.sh("systemctl is-active mu-dsh-gateway", check=False).stdout.strip() == "active", what="gateway active")
        self.assertEqual(self.sh("stat -c '%U %G %a' /run/mu-dsh/control.sock").stdout.split(), ["root", "mu-dsh", "660"])
        self.sh("test -e /etc/pam.d/mu-dsh")
        install_log = self.sh("journalctl --no-pager -u mu-dsh").stdout
        self.assertIn(f"installing @deepseek-ai/dsh@{vmlib.DSH_VERSION}", install_log)
        self.assertNotIn("not yet covered by allowScripts", install_log, "npm skipped install scripts dsh needs")
        self.assertEqual(
            self.sh("readlink /opt/mu-dsh/dsh/current").stdout.strip(), f"versions/{vmlib.DSH_VERSION}"
        )
        self.assertIn(vmlib.DSH_VERSION, self.sh("dsh --version").stdout)
        resp = wait_until(lambda: self.browser().get("/healthz"), what="gateway /healthz")
        self.assertEqual(resp.status, 200)

    def test_03_reinstall_is_idempotent(self):
        before = self.sh("sha256sum /etc/mu-dsh/config.toml").stdout
        out = self.sh("cd /root/mu-dsh && ./install.sh")
        self.assertNotIn("Next steps", out.stdout)
        self.assertIn("systemctl restart mu-dsh", out.stdout)
        self.assertEqual(self.sh("sha256sum /etc/mu-dsh/config.toml").stdout, before)
        # A source tree whose plugin submodule is not checked out is refused before anything changes.
        installed = self.sh("sha256sum /opt/mu-dsh/plugins/mu-dsh-files/lib/client.js").stdout
        self.sh("rm -rf /root/unchecked && cp -R /root/mu-dsh /root/unchecked && rm -rf /root/unchecked/plugins/mu-dsh-files/*")
        refused = self.sh("cd /root/unchecked && ./install.sh", check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("plugins/mu-dsh-files/ is not checked out; run: git submodule update --init", refused.stderr)
        self.assertEqual(self.sh("sha256sum /opt/mu-dsh/plugins/mu-dsh-files/lib/client.js").stdout, installed)
        self.sh("rm -rf /root/unchecked")

    def test_04_user_add(self):
        for user, password in PASSWORDS.items():
            self.sh(f"test ! -e /home/{user}")
            out = self.sh(f"mu-dsh user add {user} --password-stdin", input=password + "\n")
            self.assertIn("reloaded", out.stdout)
            self.assertIn("created Unix account", out.stdout)
            entry = self.sh(f"getent passwd {user}").stdout.strip().split(":")
            self.assertEqual((entry[5], entry[6]), (f"/home/{user}", "/bin/bash"))
            self.assertEqual(self.sh(f"stat -c %U /home/{user}").stdout.strip(), user)
            self.assertTrue(self.sh(f"getent shadow {user}").stdout.split(":")[1].startswith("$"), "password not set")
        for name, why in (("carol", "already exists"), ("root", "already exists"), ("Bad.Name", "invalid user name")):
            out = self.sh(f"mu-dsh user add {name} --password-stdin", input="x\n", check=False)
            self.assertNotEqual(out.returncode, 0)
            self.assertIn(why, out.stderr)
        dup = self.sh("mu-dsh user add alice --password-stdin", input="x\n", check=False)
        self.assertIn("already managed", dup.stderr)
        state = self.wait_up("alice", "bob")
        self.assertEqual(state["users"]["alice"]["port"], 20000)
        self.assertEqual(state["users"]["bob"]["port"], 20001)
        listing = self.sh("mu-dsh user list").stdout
        self.assertRegex(listing, r"alice\s+20000\s+yes\s+up")

    def test_05_provisioned_files(self):
        self.assertEqual(self.sh("stat -c '%U %a' /home/alice/.dsh").stdout.split(), ["alice", "700"])
        self.assertEqual(self.sh("stat -c '%U %a' /home/alice/.dsh/.env").stdout.split(), ["alice", "600"])
        key = self.gateway_state()["users"]["alice"]["llm_key"]
        env = self.sh("cat /home/alice/.dsh/.env").stdout
        self.assertTrue(env.startswith("# >>> mu-dsh managed >>>"), env)
        self.assertIn(f"MUDSH_LLM_KEY={key}", env)
        self.assertIn("HTTPS_PROXY='http://proxy.invalid:3128'", env)
        self.assertIn("MUDSH_TEST_VAR='from-config'", env)
        self.assertNotIn("NODE_EXTRA_CA_CERTS", env, "dsh refuses it in .env")
        environ = self.sh(f"tr '\\0' '\\n' < /proc/{self.dsh_pid(20000)}/environ").stdout.splitlines()
        self.assertIn("NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt", environ)
        # The home-level patch holds only the policy; the defaults come from a shared bundle.
        home_patch = self.sh("cat /home/alice/.dsh/cordis.patch.yml").stdout
        self.assertTrue(home_patch.startswith("# Managed by mu-dsh"))
        self.assertNotIn("llm-pi-ai", home_patch)
        bundle = "/opt/mu-dsh/dsh/node_modules/mu-dsh-defaults"
        self.assertEqual(self.sh(f"stat -c '%U %a' {bundle}/cordis.patch.yml").stdout.split(), ["root", "644"])
        for profile in ("web", "headless"):
            manifest = json.loads(self.sh(f"cat /home/alice/.dsh/profiles/{profile}/package.json").stdout)
            self.assertEqual(manifest["dsh"]["profile"]["bundles"][-1], "mu-dsh-defaults")
        self.sh("test ! -e /home/carol/.dsh")
        dump = self.sh("runuser -l alice -c 'dsh --profile web --dump-config'")
        self.assertNotIn("mu-dsh-defaults", dump.stderr, "dsh skipped the defaults bundle")
        config = dump.stdout
        self.assertIn("mode: DISABLED", config)
        self.assertRegex(config, r"patched by mu-dsh-defaults\n- id: agent-default-model\n(?:.*\n)*?\s+model: test-model")
        self.assertRegex(config, r"id: web-search-deepseek\n(?:.*\n)*?\s+disabled: true")
        self.assertIn("baseURL: http://127.0.0.1:8401/v1", config)

    def test_06_processes_run_as_their_users(self):
        for user, port in (("alice", 20000), ("bob", 20001)):
            pid = self.dsh_pid(port)
            self.assertIsNotNone(pid, f"nothing listening on {port}")
            self.assertEqual(self.sh(f"ps -o user= -p {pid}").stdout.strip(), user)
            self.assertIn("127.0.0.1:", self.sh(f"ss -ltnH 'sport = :{port}'").stdout)

    def test_07_login_and_dsh_token_exchange(self):
        b = self.browser()
        self.assertEqual(b.get("/").header("location"), "/login")
        self.assertEqual(b.get("/login").status, 200)
        self.assertEqual(b.login("alice", "wrong").status, 401)
        self.assertEqual(b.login("carol", "anything").status, 401)

        resp = b.login("alice", PASSWORDS["alice"])
        self.assertEqual((resp.status, resp.header("location")), (303, "/u/alice/"))
        chain = b.follow("/u/alice/")
        self.assertEqual([r.status for r in chain], [302, 303, 200])
        self.assertTrue(chain[0].header("location").startswith("/u/alice/?token="))
        dsh_cookie = chain[1].cookies()[0]
        self.assertIn("Path=/u/alice/", dsh_cookie)
        self.assertTrue(dsh_cookie.startswith("dsh-auth-"))
        self.assertIn(b"<!doctype html>", chain[-1].body.lower())
        self.assertIn(b'<base href="./">', chain[-1].body)
        # The UI's scripts and styles must load through the prefix too.
        html = chain[-1].body.decode()
        assets = set(re.findall(r'(?:src|href)="([^"#?]+\.(?:js|css))"', html))
        self.assertTrue(assets, "no script or stylesheet references in dsh's index")
        for asset in assets:
            self.assertFalse(asset.startswith("/"), f"absolute asset path breaks the subpath: {asset}")
            self.assertEqual(b.get("/u/alice/" + asset.removeprefix("./")).status, 200, asset)
        # Once signed in, the gateway root is a portal linking to the workspace and account pages.
        portal = b.get("/")
        self.assertEqual(portal.status, 200)
        self.assertIn(b'href="/u/alice/"', portal.body)
        self.assertIn(b'href="/account/password"', portal.body)

    def test_08_isolation_between_users(self):
        alice = self.signed_in("alice")
        self.assertEqual(alice.get("/u/bob/").status, 403)
        self.assertEqual(alice.websocket_status("/u/bob/api/remote.mux").split()[1], "403")
        anon = self.browser()
        resp = anon.get("/u/alice/")
        self.assertEqual(resp.status, 303)
        self.assertTrue(resp.header("location").startswith("/login?next="))
        # Other Unix accounts cannot sign in, even with their correct password.
        self.sh("chpasswd", input="carol:carol-pass\n")
        self.assertEqual(self.browser().login("carol", "carol-pass").status, 401)
        # A forged gateway cookie is ignored.
        anon.jar[("mu_dsh_session", "/")] = "YWxpY2U.9999999999.forged"
        self.assertEqual(anon.get("/u/alice/").status, 303)

    def test_09_websocket_through_gateway(self):
        b = self.signed_in("alice")
        self.assertIn(" 101 ", b.websocket_status("/u/alice/api/remote.mux") + " ")
        # Without dsh's own cookie, dsh itself refuses the upgrade.
        gw_only = self.browser()
        gw_only.login("alice", PASSWORDS["alice"])
        self.assertEqual(gw_only.websocket_status("/u/alice/api/remote.mux").split()[1], "401")

    def test_10_relay(self):
        users = self.gateway_state()["users"]
        self.sh("curl -sf -X DELETE http://127.0.0.1:9000/requests")
        self.assertEqual(self.relay_status(users["alice"]["llm_key"]), "200")
        self.assertEqual(self.fake_llm_requests()[-1]["authorization"], f"Bearer {REAL_KEY}")
        self.assertEqual(self.relay_status("mudsh-not-a-key"), "401")
        self.assertEqual(self.relay_status(""), "401")
        # The relay is loopback-only.
        self.assertIn("127.0.0.1:8401", self.sh("ss -ltnH 'sport = :8401'").stdout)

    def test_11_model_call_through_dsh(self):
        self.sh("curl -sf -X DELETE http://127.0.0.1:9000/requests")
        out = self.sh("runuser -l alice -c 'dsh headless \"Say hi\"'", timeout=180)
        self.assertIn(FAKE_REPLY, out.stdout)
        requests = self.fake_llm_requests()
        self.assertTrue(requests, "the fake LLM saw no request")
        self.assertTrue(all(r["authorization"] == f"Bearer {REAL_KEY}" for r in requests), requests)
        self.assertEqual(requests[0]["model"], "test-model")
        log = self.sh("journalctl --no-pager -u mu-dsh-gateway | grep 'relay: user=alice POST /v1/chat/completions'", check=False)
        self.assertTrue(log.stdout, "relay did not log alice's request")

    def test_11a_files_plugin(self):
        # Copied from the plugins/ submodule, then installed next to dsh as a dependency of the
        # defaults bundle, which mounts it.
        self.assertEqual(self.sh("ls /opt/mu-dsh/plugins/mu-dsh-files").stdout.split(), ["lib", "package.json"])
        plugin = "/opt/mu-dsh/dsh/node_modules/mu-dsh-files"
        self.assertEqual(self.sh(f"stat -c '%U %a' {plugin}/lib/client.js").stdout.split(), ["root", "644"])
        bundle = json.loads(self.sh("cat /opt/mu-dsh/dsh/node_modules/mu-dsh-defaults/package.json").stdout)
        self.assertEqual(bundle["dependencies"], {"mu-dsh-files": json.loads(self.sh(f"cat {plugin}/package.json").stdout)["version"]})
        self.assertRegex(self.sh("runuser -l alice -c 'dsh --profile web --dump-config'").stdout, r"- id: mu-dsh-files\n\s+name: mu-dsh-files")

        b = self.signed_in("alice")
        # The web client loads the browser half.
        html = b.get("/u/alice/").body.decode()
        script = re.search(r'\{"id":"mu-dsh-files","url":"([^"]+)"', html)
        self.assertIsNotNone(script, "the page's plugin graph has no mu-dsh-files")
        client = b.get("/u/alice/" + script.group(1))
        self.assertEqual(client.status, 200)
        self.assertIn(b'window.__ModuleLoader__.load({\n\tid: "mu-dsh-files"', client.body)

        # The host half's routes, through the gateway, reading as alice.
        self.sh("runuser -u alice -- sh -c 'mkdir -p ~/results/sub ~/results/empty && printf alpha > ~/results/a.txt && printf beta > ~/results/sub/b.txt'")
        api = "/u/alice/api/mu-dsh-files"
        listing = b.get(f"{api}.entry?path=/home/alice/results")
        self.assertEqual(listing.status, 200, listing.body)
        entry = json.loads(listing.body)
        self.assertEqual((entry["type"], entry["path"]), ("directory", "/home/alice/results"))
        self.assertEqual(sorted((e["name"], e["type"]) for e in entry["entries"]),
                         [("a.txt", "file"), ("empty", "directory"), ("sub", "directory")])
        self.assertEqual(json.loads(b.get(f"{api}.entry?path=/home/alice/results/a.txt").body), {"type": "file", "path": "/home/alice/results/a.txt", "size": 5})

        file = b.get(f"{api}.download?path=/home/alice/results/a.txt")
        self.assertEqual((file.status, file.body), (200, b"alpha"))
        self.assertTrue(file.header("content-disposition").startswith('attachment; filename="a.txt"'))
        archive = b.get(f"{api}.download?path=/home/alice/results")
        self.assertEqual(archive.status, 200)
        self.assertEqual(archive.header("content-type"), "application/zip")
        with zipfile.ZipFile(io.BytesIO(archive.body)) as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(sorted(z.namelist()), ["results/a.txt", "results/empty/", "results/sub/b.txt"])
            self.assertEqual(z.read("results/sub/b.txt"), b"beta")

        # dsh reads only what alice may: bob's files are refused, by name even to HEAD.
        self.assertEqual(b.get(f"{api}.download?path=/home/bob/.dsh/.env").status, 403)
        head = b.request("HEAD", f"{api}.download?path=/home/bob/.dsh")
        self.assertEqual(head.status, 403)
        self.assertIn("bob", head.header("x-mu-dsh-refusal") or "")
        # And bob cannot reach alice's routes at all.
        self.assertEqual(self.signed_in("bob").get(f"{api}.entry?path=/home/alice").status, 403)

        # Watching, through the gateway: one stream, the paths to watch asked for beside it,
        # and a change reported as it happens.
        conn, stream = b.stream(f"{api}.watch")
        try:
            self.assertEqual(stream.status, 200)
            self.assertEqual(stream.getheader("x-accel-buffering"), "no")

            def event() -> dict:
                while True:
                    line = stream.readline()
                    self.assertTrue(line, "the watch stream ended")
                    parsed = json.loads(line)
                    if parsed["type"] != "ping":
                        return parsed

            opened = event()
            self.assertEqual(opened["type"], "open")
            control = b.request("POST", f"{api}.watch", json.dumps({"stream": opened["stream"], "add": ["/home/alice/results"]}).encode(),
                                {"Content-Type": "application/json"})
            self.assertEqual(control.status, 200, control.body)
            self.assertEqual(event(), {"type": "ready", "path": "/home/alice/results"})
            self.sh("runuser -u alice -- touch /home/alice/results/new.txt")
            self.assertEqual(event(), {"type": "change", "path": "/home/alice/results"})
        finally:
            conn.close()

    def test_12_crash_recovery(self):
        b = self.signed_in("alice")
        old_token = self.gateway_state()["users"]["alice"]["token"]
        old_pid = self.dsh_pid(20000)
        self.sh(f"kill -9 {old_pid}")
        state = self.wait_state(
            lambda s: s["users"]["alice"]["up"] and s["users"]["alice"]["token"] != old_token,
            "alice restarted with a new token",
            timeout=120,
        )
        self.assertNotEqual(self.dsh_pid(20000), old_pid)
        self.assertTrue(state["users"]["bob"]["up"])
        # The existing browser's dsh cookie survives the restart (secret persisted in ~/.dsh).
        self.assertEqual(b.get("/u/alice/").status, 200)
        # A new browser goes through the new token.
        self.signed_in("alice")

    def test_12a_user_settings_override_defaults_not_policy(self):
        patches = [f"/home/alice/.dsh/profiles/{p}/cordis.patch.yml" for p in ("web", "headless")]
        for path in patches:
            self.sh(f"runuser -u alice -- tee {path} >/dev/null", input=OVERRIDE_DEFAULT_MODEL)
        self.sh("systemctl restart mu-dsh")
        self.wait_up("alice", "bob")
        for path in patches:
            self.assertEqual(self.sh(f"cat {path}").stdout, OVERRIDE_DEFAULT_MODEL, "mu-dsh touched the user's patch")
        config = self.sh("runuser -l alice -c 'dsh --profile web --dump-config'").stdout
        self.assertRegex(config, r"- id: agent-default-model\n(?:.*\n)*?\s+model: other-model")
        self.assertIn("mode: DISABLED", config)
        self.sh("curl -sf -X DELETE http://127.0.0.1:9000/requests")
        self.assertIn(FAKE_REPLY, self.sh("runuser -l alice -c 'dsh headless \"Say hi\"'", timeout=180).stdout)
        self.assertEqual(self.fake_llm_requests()[0]["model"], "other-model")
        for path in patches:
            self.sh(f"runuser -u alice -- tee {path} >/dev/null", input="[]\n")

    def workspace(self, b: Browser, action: str) -> Response:
        resp = b.request("POST", "/account/workspace", f"action={action}".encode(), {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual((resp.status, resp.header("location")), (303, "/u/alice/"), resp.body[:300])
        return resp

    def alice_in(self, mode: str, what: str) -> dict:
        return self.wait_state(lambda s: s["users"]["alice"]["up"] and s["users"]["alice"]["mode"] == mode, what, timeout=180)

    def dsh_argv_and_cwd(self, port: int) -> tuple[str, str]:
        pid = self.dsh_pid(port)
        argv = self.sh(f"tr '\\0' ' ' < /proc/{pid}/cmdline").stdout
        return argv, self.sh(f"readlink /proc/{pid}/cwd").stdout.strip()

    def test_12b_broken_config_and_recovery_mode(self):
        b = self.signed_in("alice")
        patch = "/home/alice/.dsh/profiles/web/cordis.patch.yml"
        broken = "- id: agent-default-model\n  config: [oops\n"
        self.sh(f"runuser -u alice -- tee {patch} >/dev/null", input=broken)
        # A variable dsh refuses in .env stops it before it even reads the profile.
        self.sh("runuser -u alice -- tee -a /home/alice/.dsh/.env >/dev/null", input="PATH=/broken\n")
        self.sh(f"kill -9 {self.dsh_pid(20000)}")
        state = self.wait_state(lambda s: "PATH" in (s["users"]["alice"]["error"] or ""), "alice's dsh error published", timeout=120)
        self.assertIn("only the launching environment may set", state["users"]["alice"]["error"])
        page = b.get("/u/alice/")
        self.assertEqual(page.status, 503)
        self.assertIn(b"Start in recovery mode", page.body)

        self.workspace(b, "recover")
        self.alice_in("recovery", "alice up in recovery mode")
        argv, cwd = self.dsh_argv_and_cwd(20000)
        self.assertIn("--profile mu-dsh-recovery", argv)
        self.assertEqual(cwd, "/home/alice/.dsh")
        self.assertIn("# mu-dsh recovery disabled this line; dsh refuses PATH in .env: PATH=/broken",
                      self.sh("cat /home/alice/.dsh/.env").stdout)
        self.assertEqual(self.sh(f"cat {patch}").stdout, broken, "recovery leaves the user's settings alone")
        self.assertIn(b"Recovery mode.", b.get("/").body)
        self.assertEqual(b.follow("/u/alice/")[-1].status, 200, "the workspace works in recovery mode")

        self.sh(f"runuser -u alice -- tee {patch} >/dev/null", input="[]\n")
        self.workspace(b, "restart")  # "Leave recovery mode"
        self.alice_in("normal", "alice up normally again")
        self.assertIn("--profile web", self.dsh_argv_and_cwd(20000)[0])
        self.assertNotIn(b"Recovery mode.", b.get("/").body)

    def test_12c_restart_reset_and_admin_commands(self):
        b = self.signed_in("alice")
        old_pid, old_token = self.dsh_pid(20000), self.gateway_state()["users"]["alice"]["token"]
        self.workspace(b, "restart")
        self.wait_state(lambda s: s["users"]["alice"]["up"] and s["users"]["alice"]["token"] != old_token, "alice restarted")
        self.assertNotEqual(self.dsh_pid(20000), old_pid)
        self.assertEqual(b.get("/u/alice/").status, 200, "the browser stays signed in to dsh")

        patch = "/home/alice/.dsh/profiles/web/cordis.patch.yml"
        self.sh(f"runuser -u alice -- tee {patch} >/dev/null", input=OVERRIDE_DEFAULT_MODEL)
        old_token = self.gateway_state()["users"]["alice"]["token"]
        self.assertIn(b'value="reset"', b.get("/account/reset").body)
        self.workspace(b, "reset")
        self.wait_state(lambda s: s["users"]["alice"]["up"] and s["users"]["alice"]["token"] != old_token, "alice reset")
        self.assertEqual(self.sh(f"cat {patch}").stdout, "[]\n")
        self.assertEqual(self.sh(f"cat {patch}.bak-*").stdout, OVERRIDE_DEFAULT_MODEL)

        out = self.sh("mu-dsh user restart alice --recovery").stdout
        self.assertIn("recovery mode", out)
        self.alice_in("recovery", "alice in recovery via the CLI")
        self.assertRegex(self.sh("mu-dsh user list").stdout, r"alice\s+20000\s+yes\s+up \(recovery mode\)")
        # Recovery mode does not outlive the service.
        self.sh("systemctl restart mu-dsh", timeout=180)
        self.wait_up("alice", "bob")
        self.alice_in("normal", "alice normal after a service restart")
        bob_pid = self.dsh_pid(20001)
        self.sh("mu-dsh user restart alice")
        self.alice_in("normal", "alice up after a CLI restart")
        self.assertIn("set alice's web profile settings aside", self.sh("mu-dsh user reset-settings alice").stdout)
        self.wait_up("alice")
        self.assertEqual(self.dsh_pid(20001), bob_pid, "other users are not restarted")
        refused = self.sh("mu-dsh user restart carol", check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("not an enabled mu-dsh user", refused.stderr)

    def test_13_password_change(self):
        b = self.browser()
        self.sh("mu-dsh user passwd alice --password-stdin", input="alice-pass-2\n")
        self.assertEqual(b.login("alice", "alice-pass-1").status, 401)
        self.assertEqual(b.login("alice", "alice-pass-2").status, 303)
        # A change made the Unix way (what `passwd` does) applies to the web at once.
        self.sh("chpasswd", input="alice:alice-pass-3\n")
        self.assertEqual(b.login("alice", "alice-pass-2").status, 401)
        self.assertEqual(b.login("alice", "alice-pass-3").status, 303)
        # And the user can change it from the web; the Unix password follows.
        shadow_before = self.sh("getent shadow alice").stdout
        form = {"Content-Type": "application/x-www-form-urlencoded"}
        strong = "Tq8#vLz2-mWp"
        change = f"current=alice-pass-3&new={strong}&repeat={strong}".encode().replace(b"#", b"%23")
        done = b.request("POST", "/account/password", change, form)
        self.assertEqual((done.status, done.header("location")), (303, "/?changed=password"), done.body[-300:])
        PASSWORDS["alice"] = strong
        self.assertNotEqual(self.sh("getent shadow alice").stdout, shadow_before)
        self.assertEqual(self.browser().login("alice", "alice-pass-3").status, 401)
        self.assertEqual(self.browser().login("alice", strong).status, 303)

    def test_14_locked_account(self):
        self.sh("usermod --lock bob")
        self.assertEqual(self.browser().login("bob", PASSWORDS["bob"]).status, 401)
        self.sh("usermod --unlock bob")
        self.assertEqual(self.browser().login("bob", PASSWORDS["bob"]).status, 303)

    def test_15_disable_and_enable(self):
        b = self.signed_in("bob")
        self.sh("mu-dsh user disable bob")
        wait_until(lambda: self.dsh_pid(20001) is None, timeout=60, what="bob's dsh stopped")
        wait_until(lambda: b.get("/u/bob/").status == 303, timeout=30, what="bob's session rejected")
        self.assertEqual(self.browser().login("bob", PASSWORDS["bob"]).status, 401)
        self.assertRegex(self.sh("mu-dsh user list").stdout, r"bob\s+20001\s+no\s+disabled")
        self.sh("mu-dsh user enable bob")
        self.wait_up("bob")
        self.signed_in("bob")

    def test_16_rotate_key(self):
        old_key = self.gateway_state()["users"]["alice"]["llm_key"]
        old_pid = self.dsh_pid(20000)
        self.sh("mu-dsh user rotate-key alice")
        state = self.wait_state(
            lambda s: s["users"]["alice"]["llm_key"] != old_key and s["users"]["alice"]["up"],
            "new key and alice back up",
        )
        new_key = state["users"]["alice"]["llm_key"]
        self.assertNotEqual(self.dsh_pid(20000), old_pid, "dsh should restart with the new key")
        self.assertIn(f"MUDSH_LLM_KEY={new_key}", self.sh("cat /home/alice/.dsh/.env").stdout)
        wait_until(lambda: self.relay_status(old_key) == "401", timeout=30, what="old key rejected")
        self.assertEqual(self.relay_status(new_key), "200")

    def test_17_without_public_url(self):
        """IP-only deployments: with no public_url, the host's own addresses and names work."""
        config = self.sh("cat /etc/mu-dsh/config.toml").stdout
        self.assertIn("public_url", config)
        old_pid = self.dsh_pid(20000)
        self.sh("sed -i '/^public_url/d' /etc/mu-dsh/config.toml && systemctl reload mu-dsh")
        wait_until(lambda: (pid := self.dsh_pid(20000)) is not None and pid != old_pid, what="alice's dsh restarted")
        self.wait_up("alice", "bob")
        ip = self.sh("ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1").stdout.strip()
        hostname = self.sh("hostname").stdout.strip()
        for host in (ip, hostname):
            b = Browser(self.vm.http_port, host)
            self.assertEqual(b.login("alice", PASSWORDS["alice"]).status, 303)
            chain = b.follow("/u/alice/")
            self.assertEqual(chain[-1].status, 200, (host, [(r.status, r.header("location")) for r in chain]))
            self.assertIn(" 101 ", b.websocket_status("/u/alice/api/remote.mux") + " ")
        # Restore the configured public URL for the remaining tests.
        self.sh("cat > /etc/mu-dsh/config.toml", input=config)
        self.sh("systemctl reload mu-dsh")
        wait_until(lambda: self.dsh_pid(20000) not in (None, old_pid) and self.gateway_state()["users"]["alice"]["up"]
                   and self.signed_in("alice") is not None, what="gw.test trusted again")

    def test_18_service_restart(self):
        self.sh("systemctl restart mu-dsh", timeout=300)
        wait_until(lambda: self.sh("systemctl is-active mu-dsh-gateway", check=False).stdout.strip() == "active", what="gateway active")
        self.wait_up("alice", "bob")
        self.signed_in("alice")
        self.signed_in("bob")

    def test_19_reboot(self):
        self.sh("systemctl reboot", check=False, timeout=15)
        time.sleep(5)
        self.vm.wait_ssh(timeout=300)
        self.wait_up("alice", "bob", timeout=300)
        self.signed_in("alice")

    def test_20_user_del(self):
        self.sh("runuser -u alice -- nohup sleep 600 </dev/null >/dev/null 2>&1 &")  # a stray process of alice's
        self.assertEqual(self.sh("pgrep -x sleep", check=False).returncode, 0)
        out = self.sh("mu-dsh user del alice")
        self.assertIn("deleted the Unix account", out.stdout)
        self.assertIsNone(self.dsh_pid(20000))
        self.assertNotEqual(self.sh("id alice", check=False).returncode, 0)
        self.sh("test ! -e /home/alice")
        self.assertEqual(self.sh("pgrep -x sleep", check=False).returncode, 1, "alice's processes survived")
        self.assertEqual(self.browser().login("alice", PASSWORDS["alice"]).status, 401)
        self.assertNotIn("alice", self.gateway_state()["users"])
        self.assertTrue(self.gateway_state()["users"]["bob"]["up"])

    def test_21_uninstall(self):
        self.sh("cd /root/mu-dsh && ./install.sh --uninstall --purge", timeout=120)
        for path in ["/opt/mu-dsh", "/etc/mu-dsh", "/var/lib/mu-dsh", "/usr/local/bin/mu-dsh", "/usr/local/bin/dsh",
                     "/etc/systemd/system/mu-dsh.service"]:
            self.sh(f"test ! -e {path}")
        self.sh("test ! -e /etc/pam.d/mu-dsh")
        self.assertNotEqual(self.sh("id mu-dsh", check=False).returncode, 0)
        self.assertIsNone(self.dsh_pid(20001))
        # --purge deletes the accounts mu-dsh created, and only those.
        self.assertNotEqual(self.sh("id bob", check=False).returncode, 0)
        self.sh("test ! -e /home/bob")
        self.sh("id carol && test -d /home/carol")


if __name__ == "__main__":
    unittest.main(failfast=True, verbosity=2)
