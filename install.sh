#!/bin/sh
# Install (or upgrade) mu-dsh from this source tree. Safe to re-run.
#
#   sudo ./install.sh                     install or upgrade
#   sudo ./install.sh --uninstall         remove code, units, and wrappers (keeps users)
#   sudo ./install.sh --uninstall --purge also delete every managed user's Unix account and
#                                         home, and /etc/mu-dsh, /var/lib/mu-dsh, /var/cache/mu-dsh
#
# Requires: python3 >= 3.11, node >= 23.6 with npm, systemd, PAM (Debian-style common-*).
set -eu

PREFIX=/opt/mu-dsh
ETC=/etc/mu-dsh
STATE=/var/lib/mu-dsh
CACHE=/var/cache/mu-dsh
UNITS=/etc/systemd/system
PAM=/etc/pam.d/mu-dsh
BIN=/usr/local/bin
SVC_USER=mu-dsh
SRC=$(cd "$(dirname "$0")" && pwd)

die() { echo "install.sh: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

uninstall() {
    purge=$1
    if [ "$purge" = yes ] && [ -x "$BIN/mu-dsh" ]; then
        # mu-dsh owns its users' accounts: delete them while the service still runs.
        for user in $("$BIN/mu-dsh" user list --names 2>/dev/null); do
            "$BIN/mu-dsh" user del "$user" || echo "install.sh: could not delete $user" >&2
        done
    fi
    if command -v systemctl >/dev/null; then
        systemctl disable --now mu-dsh.service mu-dsh-gateway.service 2>/dev/null || true
    fi
    rm -f "$UNITS/mu-dsh.service" "$UNITS/mu-dsh-gateway.service" "$BIN/mu-dsh"
    if [ -L "$BIN/dsh" ] && [ "$(readlink "$BIN/dsh")" = "$PREFIX/dsh/current/bin/dsh" ]; then
        rm -f "$BIN/dsh"
    fi
    rm -rf "$PREFIX"
    if [ "$purge" = yes ]; then
        rm -rf "$ETC" "$STATE" "$CACHE" "$PAM"
        userdel "$SVC_USER" 2>/dev/null || true
        say "purged managed users, configuration, and state"
    fi
    command -v systemctl >/dev/null && systemctl daemon-reload || true
    say "mu-dsh uninstalled"
}

case "${1:-}" in
    --uninstall)
        uninstall "$([ "${2:-}" = --purge ] && echo yes || echo no)"
        exit 0
        ;;
    "") ;;
    *) die "unknown option $1" ;;
esac

# --- prerequisites -----------------------------------------------------------
PYTHON=$(command -v python3) || die "python3 not found"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "python3 >= 3.11 required"
NODE=$(command -v node) || die "node not found (Node.js >= 23.6 required)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)' \
    || die "node >= 23.6 required (found $("$NODE" --version))"
[ -x "$(dirname "$NODE")/npm" ] || command -v npm >/dev/null || die "npm not found"
command -v systemctl >/dev/null || die "systemd is required"
for tool in useradd userdel chpasswd pkill pgrep; do
    command -v "$tool" >/dev/null || die "$tool not found"
done
ldconfig -p 2>/dev/null | grep -q 'libpam\.so\.0' || die "libpam (libpam0g) not found"

# --- service account ---------------------------------------------------------
if ! id "$SVC_USER" >/dev/null 2>&1; then
    say "creating system user $SVC_USER"
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
fi

# --- code ----------------------------------------------------------------------
say "installing code into $PREFIX"
install -d -m 0755 "$PREFIX" "$PREFIX/gateway"
rm -rf "$PREFIX/control" "$PREFIX/gateway/src"
cp -R "$SRC/control" "$PREFIX/control"
cp -R "$SRC/gateway/src" "$PREFIX/gateway/src"
cp "$SRC/gateway/package.json" "$PREFIX/gateway/package.json"
cp "$SRC/README.md" "$PREFIX/README.md" 2>/dev/null || true
find "$PREFIX/control" -name __pycache__ -prune -exec rm -rf {} +
chown -R root:root "$PREFIX/control" "$PREFIX/gateway"
chmod -R u=rwX,go=rX "$PREFIX/control" "$PREFIX/gateway"

cat > "$BIN/mu-dsh" <<EOF
#!/bin/sh
# mu-dsh command line (installed by install.sh)
exec "$PYTHON" -I -c 'import sys; sys.path.insert(0, "$PREFIX"); from control.cli import main; sys.exit(main())' "\$@"
EOF
chmod 0755 "$BIN/mu-dsh"

# Let users run the managed dsh from their shells too, unless they already have one.
if [ ! -e "$BIN/dsh" ] && [ ! -L "$BIN/dsh" ]; then
    ln -s "$PREFIX/dsh/current/bin/dsh" "$BIN/dsh"
fi

# --- configuration and state -----------------------------------------------
install -d -m 0755 "$ETC"
if [ ! -e "$ETC/config.toml" ]; then
    install -m 0600 "$SRC/packaging/config.example.toml" "$ETC/config.toml"
    say "wrote $ETC/config.toml from the example; edit it before starting"
    FRESH_CONFIG=yes
else
    FRESH_CONFIG=no
fi
install -d -m 0700 "$STATE" "$CACHE"
if [ ! -e "$PAM" ]; then
    install -m 0644 "$SRC/packaging/pam.d-mu-dsh" "$PAM"
fi

# --- systemd -------------------------------------------------------------------
install -m 0644 "$SRC/packaging/mu-dsh.service" "$UNITS/mu-dsh.service"
sed "s|@NODE@|$NODE|" "$SRC/packaging/mu-dsh-gateway.service" > "$UNITS/mu-dsh-gateway.service"
chmod 0644 "$UNITS/mu-dsh-gateway.service"
systemctl daemon-reload

say "installed"
if [ "$FRESH_CONFIG" = yes ]; then
    cat <<EOF

Next steps:
  1. sudoedit $ETC/config.toml          # public URL and the inference service
  2. sudo systemctl enable --now mu-dsh  # first start installs dsh from npm
  3. sudo mu-dsh user add <name>         # creates the Unix account; its password is the web password
EOF
elif systemctl is-active --quiet mu-dsh.service; then
    echo "mu-dsh is running; apply the upgrade with: sudo systemctl restart mu-dsh"
fi
