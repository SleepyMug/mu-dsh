"""Write mu-dsh's managed files into one user's ~/.dsh.

This script runs *as the target user* (the daemon starts it with that user's
uid/gid and ``python3 -I``), so it never follows a user-controlled symlink
with root privileges. It imports nothing from the control package; the
caller sends everything it needs as JSON on stdin:

    {"dsh_home": "...", "env_block": "...", "env_begin": "...", "env_end": "...",
     "home_patch": "...", "patch_marker": "...",
     "bundle": "mu-dsh-defaults", "base_bundle": "@deepseek-ai/dsh-base"}

It puts the managed block at the top of ~/.dsh/.env, writes the home-level
patch (keeping one backup of a file the user wrote there), and lists the
defaults bundle in every profile built on dsh's base bundle, right after
dsh's own bundles.
"""

import glob
import json
import os
import sys


def atomic_write(path, text, mode):
    tmp = f"{path}.mu-dsh-tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return None


def strip_block(text, begin, end):
    out, inside = [], False
    for line in text.splitlines(keepends=True):
        s = line.strip()
        if s == begin:
            inside = True
        elif s == end:
            inside = False
        elif not inside:
            out.append(line)
    result = "".join(out)
    if result and not result.endswith("\n"):
        result += "\n"
    return result


def write_env(home, req):
    path = os.path.join(home, ".env")
    user_env = strip_block(read(path) or "", req["env_begin"], req["env_end"]).lstrip("\n")
    text = req["env_block"] + ("\n" + user_env if user_env else "")
    if read(path) != text:
        atomic_write(path, text, 0o600)


def write_home_patch(home, req):
    path = os.path.join(home, "cordis.patch.yml")
    existing = read(path)
    if existing is not None and not existing.startswith(req["patch_marker"]):
        backup = path + ".pre-mu-dsh"
        if not os.path.lexists(backup):
            atomic_write(backup, existing, 0o600)
    if existing != req["home_patch"]:
        atomic_write(path, req["home_patch"], 0o600)


def list_bundle(path, req):
    try:
        manifest = json.loads(read(path) or "")
        profile = manifest["dsh"]["profile"]
    except (ValueError, KeyError, TypeError):
        return  # not a profile dsh can load anyway; leave it to the user
    if req["base_bundle"] not in profile.get("bundles", []):
        return
    bundles = [b for b in profile["bundles"] if b != req["bundle"]]
    # Directly above dsh's own bundles, below any the user installed.
    shipped = [i for i, b in enumerate(bundles) if b.startswith("@deepseek-ai/")]
    bundles.insert(shipped[-1] + 1 if shipped else 0, req["bundle"])
    if profile.get("bundles") != bundles:
        profile["bundles"] = bundles
        atomic_write(path, json.dumps(manifest, indent=2) + "\n", 0o644)


def main():
    req = json.load(sys.stdin)
    home = req["dsh_home"]
    os.makedirs(home, mode=0o700, exist_ok=True)
    os.chmod(home, 0o700)
    write_env(home, req)
    write_home_patch(home, req)
    for manifest in sorted(glob.glob(os.path.join(glob.escape(home), "profiles", "*", "package.json"))):
        list_bundle(manifest, req)


if __name__ == "__main__":
    main()
