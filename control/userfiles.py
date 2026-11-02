"""Write mu-dsh's managed files into one user's ~/.dsh.

This script runs *as the target user* (the daemon starts it with that user's
uid/gid and ``python3 -I``), so it never follows a user-controlled symlink
with root privileges. It imports nothing from the control package; the
caller sends everything it needs as JSON on stdin:

    {"dsh_home": "...", "env_block": "...", "patch": "...",
     "patch_marker": "...", "env_begin": "...", "env_end": "..."}
"""

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


def main():
    req = json.load(sys.stdin)
    home = req["dsh_home"]
    env_path = os.path.join(home, ".env")
    patch_path = os.path.join(home, "cordis.patch.yml")
    env_text = read(env_path)
    user_env = strip_block(env_text or "", req["env_begin"], req["env_end"])
    patch_existing = read(patch_path)

    os.makedirs(home, mode=0o700, exist_ok=True)
    os.chmod(home, 0o700)
    sep = "\n" if user_env and not user_env.endswith("\n\n") else ""
    atomic_write(env_path, user_env + sep + req["env_block"], 0o600)
    if patch_existing is not None and not patch_existing.startswith(req["patch_marker"]):
        backup = patch_path + ".pre-mu-dsh"
        if not os.path.exists(backup):
            atomic_write(backup, patch_existing, 0o600)
    if patch_existing != req["patch"]:
        atomic_write(patch_path, req["patch"], 0o600)


if __name__ == "__main__":
    main()
