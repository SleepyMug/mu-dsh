"""QEMU harness for mu-dsh's system tests (standard library only).

Two disk layers keep runs fast and isolated:

* ``.cache/base.qcow2`` — Debian 13 cloud image + guest-prep.sh (packages,
  Node.js, test users, a warm npm cache). Built once by ``vm.py build-base``
  and rebuilt automatically when its inputs change.
* every test run boots ``base.qcow2`` with QEMU ``-snapshot``: all writes go
  to a throwaway layer, so each full run starts from the same clean state.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CACHE = HERE / ".cache"

DEBIAN_BASE_URL = "https://cloud.debian.org/images/cloud/trixie/latest/"
DEBIAN_IMAGE = "debian-13-genericcloud-amd64.qcow2"
NODE_VERSION = "v26.13.0"
NODE_TARBALL = f"node-{NODE_VERSION}-linux-x64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/{NODE_VERSION}/"
# dsh version the system tests pin (and the base image pre-caches).
DSH_VERSION = "0.2.1-rc.5"

BASE_DISK = CACHE / "base.qcow2"
BASE_STAMP = CACHE / "base.stamp"
SSH_KEY = CACHE / "id_ed25519"
STATE_FILE = CACHE / "vm.json"
CONSOLE_LOG = CACHE / "console.log"

MEMORY_MB = int(os.environ.get("MU_DSH_VM_MEMORY", "4096"))
CPUS = int(os.environ.get("MU_DSH_VM_CPUS", "4"))


def log(msg: str) -> None:
    print(f"[vm] {msg}", file=sys.stderr, flush=True)


# --- downloads -----------------------------------------------------------------


def _download(url: str, dest: Path) -> None:
    log(f"downloading {url}")
    part = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url) as resp, open(part, "wb") as f:
        shutil.copyfileobj(resp, f, length=1 << 20)
    part.replace(dest)


def _checksum(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _expected_sum(sums_file: Path, name: str) -> str:
    for line in sums_file.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == name:
            return parts[0]
    raise RuntimeError(f"{name} not listed in {sums_file}")


def _fetch_verified(base_url: str, name: str, sums_name: str, algo: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    sums = CACHE / f"{name}.{sums_name}"
    if dest.exists() and sums.exists():
        return dest
    _download(base_url + sums_name, sums)
    _download(base_url + name, dest)
    if _checksum(dest, algo) != _expected_sum(sums, name):
        dest.unlink()
        raise RuntimeError(f"checksum mismatch for {name}")
    log(f"verified {name}")
    return dest


def ensure_inputs() -> tuple[Path, Path]:
    # A pre-downloaded image with the plain SHA512SUMS name is accepted too.
    legacy = CACHE / "SHA512SUMS"
    if (CACHE / DEBIAN_IMAGE).exists() and legacy.exists() and not (CACHE / f"{DEBIAN_IMAGE}.SHA512SUMS").exists():
        legacy.rename(CACHE / f"{DEBIAN_IMAGE}.SHA512SUMS")
    image = _fetch_verified(DEBIAN_BASE_URL, DEBIAN_IMAGE, "SHA512SUMS", "sha512")
    node = _fetch_verified(NODE_URL, NODE_TARBALL, "SHASUMS256.txt", "sha256")
    if not SSH_KEY.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "mu-dsh-vm", "-f", str(SSH_KEY)], check=True)
    return image, node


def base_stamp() -> str:
    prep = (HERE / "guest-prep.sh").read_bytes()
    return hashlib.sha256(b"\0".join([prep, NODE_VERSION.encode(), DSH_VERSION.encode(), DEBIAN_IMAGE.encode()])).hexdigest()


def base_is_current() -> bool:
    return BASE_DISK.exists() and BASE_STAMP.exists() and BASE_STAMP.read_text().strip() == base_stamp()


# --- QEMU ------------------------------------------------------------------------


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kvm_available() -> bool:
    return os.access("/dev/kvm", os.R_OK | os.W_OK)


class SeedServer:
    """Serves cloud-init NoCloud files; the guest reaches the host at 10.0.2.2."""

    def __init__(self, files: dict[str, str]):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = files.get(self.path.lstrip("/"))
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = body.encode()
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


class VM:
    def __init__(self, ssh_port: int, http_port: int, pid: int | None = None):
        self.ssh_port = ssh_port
        self.http_port = http_port  # host port forwarded to the guest's gateway port 8080
        self.pid = pid

    # -- lifecycle --

    @classmethod
    def boot(cls, disk: Path, *, snapshot: bool, seed_port: int | None = None) -> "VM":
        CACHE.mkdir(parents=True, exist_ok=True)
        vm = cls(ssh_port=free_port(), http_port=free_port())
        pidfile = CACHE / "qemu.pid"
        pidfile.unlink(missing_ok=True)
        accel = ["-machine", "q35,accel=kvm", "-cpu", "host"] if kvm_available() else ["-machine", "q35,accel=tcg", "-cpu", "max"]
        if not kvm_available():
            log("warning: /dev/kvm not usable; falling back to slow TCG emulation")
        cmd = [
            "qemu-system-x86_64",
            *accel,
            "-m", str(MEMORY_MB),
            "-smp", str(CPUS),
            "-display", "none",
            "-serial", f"file:{CONSOLE_LOG}",
            "-drive", f"file={disk},if=virtio,format=qcow2,discard=unmap",
            "-nic", f"user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:{vm.ssh_port}-:22,hostfwd=tcp:127.0.0.1:{vm.http_port}-:8080",
            "-daemonize",
            "-pidfile", str(pidfile),
        ]
        if snapshot:
            cmd.append("-snapshot")
        if seed_port is not None:
            cmd += ["-smbios", f"type=1,serial=ds=nocloud;s=http://10.0.2.2:{seed_port}/"]
        subprocess.run(cmd, check=True)
        vm.pid = int(pidfile.read_text().strip())
        log(f"booted pid {vm.pid}: ssh port {vm.ssh_port}, gateway port {vm.http_port}")
        return vm

    def save(self) -> None:
        STATE_FILE.write_text(json.dumps({"ssh_port": self.ssh_port, "http_port": self.http_port, "pid": self.pid}))

    @classmethod
    def load(cls) -> "VM | None":
        try:
            data = json.loads(STATE_FILE.read_text())
        except FileNotFoundError:
            return None
        vm = cls(data["ssh_port"], data["http_port"], data["pid"])
        return vm if vm.alive() else None

    def alive(self) -> bool:
        if self.pid is None:
            return False
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return False
        return True

    def wait_exit(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self.alive():
            if time.monotonic() > deadline:
                return False
            time.sleep(0.5)
        return True

    def kill(self) -> None:
        if self.alive():
            os.kill(self.pid, 15)
            if not self.wait_exit(10):
                os.kill(self.pid, 9)
        STATE_FILE.unlink(missing_ok=True)

    def poweroff(self, timeout: float = 120) -> None:
        self.ssh("systemctl poweroff", check=False, timeout=15)
        if not self.wait_exit(timeout):
            log("guest did not power off in time; killing QEMU")
        self.kill()

    # -- access --

    def ssh_argv(self, *extra: str) -> list[str]:
        return [
            "ssh",
            "-i", str(SSH_KEY),
            "-p", str(self.ssh_port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=10",
            *extra,
            "root@127.0.0.1",
        ]

    def ssh(self, command: str, *, check: bool = True, input: str | bytes | None = None, timeout: float = 600) -> subprocess.CompletedProcess:
        text = not isinstance(input, bytes)
        proc = subprocess.run(
            self.ssh_argv() + [command], input=input, capture_output=True, text=text, timeout=timeout
        )
        if check and proc.returncode != 0:
            raise RuntimeError(f"guest command failed ({proc.returncode}): {command}\n--- stdout\n{proc.stdout}\n--- stderr\n{proc.stderr}")
        return proc

    def wait_ssh(self, timeout: float = 300) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.alive():
                raise RuntimeError(f"QEMU exited during boot; see {CONSOLE_LOG}")
            try:
                if self.ssh("true", check=False, timeout=15).returncode == 0:
                    return
            except subprocess.TimeoutExpired:
                pass
            time.sleep(2)
        raise TimeoutError(f"no SSH after {timeout:.0f}s; see {CONSOLE_LOG}")

    def put_file(self, local: Path, remote: str) -> None:
        subprocess.run(
            ["scp", "-q", "-i", str(SSH_KEY), "-P", str(self.ssh_port), "-o", "StrictHostKeyChecking=no",
             "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", str(local), f"root@127.0.0.1:{remote}"],
            check=True,
        )

    def put_repo(self, remote: str = "/root/mu-dsh") -> None:
        """Copy the working tree (tracked and untracked, minus ignored files)."""
        files = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=REPO, capture_output=True, check=True,
        ).stdout
        names = [n for n in files.decode().split("\0") if n and (REPO / n).exists()]
        tar = subprocess.run(["tar", "-c", "-f", "-", "-C", str(REPO), "--", *names], capture_output=True, check=True).stdout
        self.ssh(f"rm -rf {shlex.quote(remote)} && mkdir -p {shlex.quote(remote)} && tar -x -f - -C {shlex.quote(remote)}", input=tar)


def build_base(force: bool = False) -> None:
    if base_is_current() and not force:
        log("base image is current")
        return
    image, node = ensure_inputs()
    tmp = CACHE / "base.qcow2.tmp"
    tmp.unlink(missing_ok=True)
    subprocess.run(["qemu-img", "create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", str(image), str(tmp), "20G"], check=True)
    pubkey = (SSH_KEY.with_suffix(".pub")).read_text().strip()
    seed = SeedServer(
        {
            "meta-data": "instance-id: mu-dsh-base\nlocal-hostname: mu-dsh-test\n",
            "user-data": "#cloud-config\n"
            "disable_root: false\n"
            "ssh_pwauth: false\n"
            f"ssh_authorized_keys:\n  - {pubkey}\n",
            "vendor-data": "",
        }
    )
    log("building base image (first boot + guest-prep.sh); this takes a few minutes")
    vm = VM.boot(tmp, snapshot=False, seed_port=seed.port)
    try:
        vm.wait_ssh(timeout=600)
        seed.close()
        vm.ssh("cloud-init status --wait >/dev/null 2>&1 || true", timeout=600)
        vm.put_file(node, "/root/node.tar.xz")
        vm.put_file(HERE / "guest-prep.sh", "/root/guest-prep.sh")
        proc = vm.ssh(f"sh /root/guest-prep.sh {shlex.quote(DSH_VERSION)}", check=False, timeout=1800)
        sys.stderr.write(proc.stdout[-4000:] + proc.stderr[-4000:])
        if proc.returncode != 0:
            raise RuntimeError("guest-prep.sh failed")
        vm.poweroff()
    except BaseException:
        vm.kill()
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(BASE_DISK)
    BASE_STAMP.write_text(base_stamp() + "\n")
    log(f"base image ready: {BASE_DISK}")


def boot_fresh() -> VM:
    """Boot a throwaway VM from the current base image."""
    build_base()
    existing = VM.load()
    if existing is not None:
        log(f"stopping previous VM (pid {existing.pid})")
        existing.kill()
    vm = VM.boot(BASE_DISK, snapshot=True)
    vm.save()
    vm.wait_ssh()
    return vm
