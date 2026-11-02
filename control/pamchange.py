"""Change one user's password the way passwd(1) does.

Started as root by PamAuthenticator.change with a JSON request on stdin. It
sets its real uid to the user while keeping effective uid root, so pam_unix
treats the change as the user's own: it checks the current password and
enforces the normal password rules, yet can still write /etc/shadow. Prints
{"error": null | "<PAM's complaint>"}.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from control.pam import PamAuthenticator  # noqa: E402


def main() -> None:
    req = json.load(sys.stdin)
    os.setresuid(req["uid"], 0, 0)
    error = PamAuthenticator(req["service"]).change_as_caller(req["user"], req["current"], req["new"])
    json.dump({"error": error}, sys.stdout)


if __name__ == "__main__":
    main()
