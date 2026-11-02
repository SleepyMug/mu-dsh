# mu-dsh

Multi-user [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh) for one Linux host.
A root service installs a pinned dsh, creates and owns one Unix account per user,
runs one `dsh web` per user (as that user, in their own `~/.dsh`), and puts a
login gateway in front of them. The web password is the account's Unix password.
Every user's dsh is pre-configured to reach one shared OpenAI-compatible
inference service through a relay that holds the real API key.

Intended for a trusted on-premises network: the gateway accepts Unix passwords
over plain HTTP, and other shell users on the host are not treated as adversaries.

```
 browser ──► gateway :8080 ── /login, /logout
                 │
                 └─ /u/<user>/* ──► 127.0.0.1:<port>  dsh web (runs as <user>)
                                         │
 relay 127.0.0.1:8401 ◄──────────────────┘  per-user key
   └──► upstream LLM (real key)
```

## Usage

**Setup**
1. Prerequisites: systemd, Python 3.11+, Node.js 23.6+ with npm.
2. `git clone git@github.com:SleepyMug/mu-dsh.git && cd mu-dsh && sudo ./install.sh`
3. `sudoedit /etc/mu-dsh/config.toml` — the `[llm]` section; optionally `public_url`
   (left out, users open `http://<any of this host's IPv4 addresses or names>:8080/`).
4. `sudo systemctl enable --now mu-dsh` (first start downloads dsh from npm).

**Users** (each is a Unix account mu-dsh creates and owns)
- Add (creates the account): `sudo mu-dsh user add alice`
- Set password (admin, no rules applied): `sudo mu-dsh user passwd alice`
- Disable / enable (stops dsh and web sign-in): `sudo mu-dsh user disable|enable alice`
- New relay key: `sudo mu-dsh user rotate-key alice`
- Remove (deletes account and home): `sudo mu-dsh user del alice`
- List: `sudo mu-dsh user list`

**dsh update**
1. Change `[dsh] version` in `config.toml`.
2. `sudo systemctl restart mu-dsh`

**Model configuration**
1. Edit `[llm]` (`base_url`, `api_key`, `default_model`) and `[[llm.models]]` in `config.toml`.
2. `sudo systemctl reload mu-dsh`

**mu-dsh update**
- `git pull && sudo ./install.sh && sudo systemctl restart mu-dsh`

**Uninstall**
- Keep users and data: `sudo ./install.sh --uninstall`
- Remove everything, including user accounts: `sudo ./install.sh --uninstall --purge`

**Logs**
- `journalctl -u mu-dsh -u mu-dsh-gateway`

**What users do**
1. Open the public URL; sign in with their Unix user name and password.
2. They land in their own dsh. `/` has "Change password" and "Sign out".
3. A web password change follows the same rules as `passwd` and changes the Unix password; `passwd` in a shell works too.

## Components

| Part | Language | Runs as | Role |
|---|---|---|---|
| `control/` → `mu-dsh` | Python 3.11+, stdlib only | root | CLI, Unix accounts, provisioning, dsh install, supervising one dsh per user, PAM password checks |
| `gateway/` | TypeScript on Node ≥ 23.6, no runtime dependencies | `mu-dsh` | login, per-user reverse proxy (HTTP + WebSocket), LLM relay |

They share two things in `/run/mu-dsh`: `gateway.json` (users and process state,
format in `control/state.py`), written by the Python side and watched by the
gateway; and `auth.sock`, where the gateway asks the root daemon to check a
password through PAM (`control/authserver.py`).

Both halves use plain constructor injection: every class receives its
collaborators, and one composition root per half builds them all, so
reading it shows how the system fits together.

* `control/wiring.py` — `UserStore` + `Accounts` → `UserAdmin` (user lifecycle);
  `Provisioner` → `Launcher` → `Supervisor`; `DshInstaller` → `SpecBuilder`;
  `UserStore` + `PamAuthenticator` → `AuthServer`; all of them plus `ConfigFile`,
  `StateFile`, `SessionSecret`, and `PidFile` → `Daemon`. `cli.py` only parses
  arguments and calls these services.
* `gateway/src/app.ts` — a `StateSource` (`StateFile` in production,
  `MemoryState` in tests), `Sessions`, a `PasswordVerifier`
  (`SocketPasswordVerifier`), `DshProxy`, and a `Logger` → `Gateway`;
  `StateSource` + `Logger` → `Relay`. `main.ts` only loads the state file and listens.

### Users are Unix accounts

`mu-dsh user add` creates the Unix account (home directory, `/bin/bash`) and
sets its password; it refuses names that already exist, so mu-dsh only ever
manages accounts it created. `mu-dsh user del` stops the user's processes and
deletes the account with its home directory. The web password is the Unix
password, checked through the PAM service `mu-dsh` (`/etc/pam.d/mu-dsh`), so a
password changed with `passwd` applies to the web at once and locked or expired
accounts cannot sign in. Only managed, enabled users can sign in to the web.

Signed-in users get a small portal at `/` (open the workspace, change password,
sign out). The password page at `/account/password` checks the current
password and sets the new one through PAM the way `passwd` does (a helper whose
real uid is the user), so it changes the Unix password and follows the site's
usual rules; mu-dsh adds none of its own. (`mu-dsh user add`/`passwd` are admin
actions and set passwords directly.)

### What mu-dsh writes in a user's home

Only two things, both inside `~/.dsh`:

* `~/.dsh/cordis.patch.yml` — dsh's home-level patch layer, applied to every
  profile. mu-dsh owns and rewrites it: the relay as an `openai-completions`
  provider, the default model, web search off, telemetry off. A pre-existing
  file is kept as `cordis.patch.yml.pre-mu-dsh`.
* a marked block in `~/.dsh/.env` with `MUDSH_LLM_KEY`, the user's relay key.

Users' own settings go in `~/.dsh/profiles/<profile>/cordis.patch.yml` (the
dsh settings UI writes there). Rows mu-dsh sets win over the same rows there.
Users can also run `dsh` from their shell (`/usr/local/bin/dsh`); it picks up
the same configuration.

### How sign-in works

0. dsh only accepts requests whose `Host` is one it trusts. With `public_url`
   set, that is its host name; without it, each dsh trusts the machine's own
   global IPv4 addresses, hostname, and FQDN (found at start or reload).
1. `POST /login` asks the daemon to check the Unix password (PAM) and sets the
   gateway's `mu_dsh_session` cookie.
2. `/u/<user>/*` is proxied only for that user. The original `Host` header is
   kept (dsh checks it against `--trusted-host`), and the gateway's cookie is
   removed before the request reaches dsh.
3. dsh answers its index with 401 until the browser holds dsh's own cookie. The
   gateway turns that 401 into a redirect through dsh's launch-token exchange
   (`?token=`); the supervisor reads the token from dsh's startup output.
4. dsh's cookie has `Path=/` and a name derived only from the host, so the
   gateway rewrites its path to `/u/<user>/` to keep users' cookies apart.

## Install

Prerequisites: systemd, `python3` ≥ 3.11, Node.js ≥ 23.6 with `npm` on `PATH`
(Debian 13's packaged Node is too old; use the nodejs.org tarball or NodeSource),
and network access to the npm registry (or a mirror) on first start.

```sh
git clone <repo> mu-dsh && cd mu-dsh
sudo ./install.sh                       # code → /opt/mu-dsh, units, /usr/local/bin/mu-dsh
sudoedit /etc/mu-dsh/config.toml        # public URL, inference service, models
sudo systemctl enable --now mu-dsh      # first start installs dsh from npm
sudo mu-dsh user add alice              # creates the Unix account; prompts for its password
```

Users then open `public_url` (e.g. `http://gw.example.internal:8080/`) and sign in.

Upgrade mu-dsh: `git pull && sudo ./install.sh && sudo systemctl restart mu-dsh`.
Upgrade dsh: change `dsh.version` in the config, then `sudo systemctl restart mu-dsh`.
Remove: `sudo ./install.sh --uninstall` keeps users and state; `--uninstall --purge`
also deletes every managed user's account and home directory.

| Path | Contents |
|---|---|
| `/opt/mu-dsh/{control,gateway}` | code |
| `/opt/mu-dsh/dsh/versions/<v>`, `current` | pinned dsh installs (current + previous kept) |
| `/etc/mu-dsh/config.toml` | configuration (0600; holds the upstream key) |
| `/var/lib/mu-dsh/users.json`, `session-secret` | managed users, ports, relay keys |
| `/run/mu-dsh/gateway.json`, `auth.sock` | control plane ↔ gateway (root:mu-dsh) |
| `/etc/pam.d/mu-dsh` | PAM service for web sign-ins (kept if edited) |

## Configuration

See `packaging/config.example.toml`; every key is documented there. After
editing, `sudo systemctl reload mu-dsh` re-provisions every user and restarts
only the dsh instances whose configuration changed.

## Commands

```
mu-dsh user add NAME [--password-stdin]     # creates the Unix account
mu-dsh user del NAME                        # deletes the account and its home
mu-dsh user passwd NAME [--password-stdin]  # same as passwd; no reload needed
mu-dsh user enable|disable NAME
mu-dsh user rotate-key NAME             # new relay key; restarts that user's dsh
mu-dsh user list [--names]
mu-dsh check-config
mu-dsh install-dsh                      # systemd runs this before every start
mu-dsh serve                            # the service itself
```

User changes signal the running service to reload; nothing else needs restarting.
Logs: `journalctl -u mu-dsh -u mu-dsh-gateway` (each dsh's output is
prefixed with its user; relay requests are logged per user).

## Tests

```sh
python3 -m unittest discover -s tests/unit      # control plane (host)
cd gateway && node --test test/                 # gateway (host)
python3 tests/vm/vm.py test                     # full system tests in a QEMU VM
```

The system tests need `qemu-system-x86_64`, `qemu-img`, `ssh`, and ideally
`/dev/kvm`. The first run downloads the Debian 13 cloud image and Node.js
(checksums verified) and builds `tests/vm/.cache/base.qcow2`: packages, Node,
a pre-existing account `carol` (which mu-dsh must refuse), and a warm npm cache. That takes a couple of
minutes and is redone automatically when `guest-prep.sh`, the Node version, or
the pinned dsh version changes. Every run then boots the base image with QEMU
`-snapshot`, so each run starts from the same clean state and nothing is written
back. The suite installs mu-dsh with `install.sh`, starts a fake OpenAI-compatible
upstream in the VM (`tests/vm/fake_llm.py`), and checks provisioning, sign-in,
isolation, WebSockets, the relay, a real `dsh headless` model call, crash
recovery, Unix password changes and locked accounts, reloads, a reboot, account
deletion, and uninstall.

```sh
python3 tests/vm/vm.py test -k relay --keep     # run up to test_10_relay; keep the VM afterwards
python3 tests/vm/vm.py up                       # a fresh VM to poke at
python3 tests/vm/vm.py ssh                      # shell into it
python3 tests/vm/vm.py down
python3 tests/vm/vm.py build-base --force       # rebuild the base image
```

For type-checking the gateway: `cd gateway && npm install && npm run typecheck`.

## Known limitations

* Sign-in sends Unix passwords over plain HTTP; put a TLS-terminating proxy in
  front for anything beyond a trusted LAN. Repeated failures are slowed only by
  PAM's failure delay (add `pam_faillock` to `/etc/pam.d/mu-dsh` for lockouts).
* Disabling a user stops their dsh and web sign-in but not their Unix login.
* Changing a password does not end existing gateway sessions; disabling or
  removing a user does.
* dsh's `web_search` tool may still be listed in agent presets; its backends
  are disabled, so calls to it fail.
* All enabled users' dsh instances start at boot (one Node process each).
