#!/bin/sh
# Runs once inside the VM to build the base image (see vmlib.build_base).
# Usage: sh guest-prep.sh <dsh-version>; expects /root/node.tar.xz.
set -eux
DSH_VERSION=$1
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends python3 curl ca-certificates xz-utils procps iproute2 sudo

# Node.js from the official tarball (Debian's packaged Node is too old for dsh).
tar -xJf /root/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/CHANGELOG.md'
rm -f /root/node.tar.xz
node --version
npm --version

# A pre-existing account: mu-dsh must refuse to take it over. (alice and bob
# are created by `mu-dsh user add` during the tests.)
id carol >/dev/null 2>&1 || useradd --create-home --shell /bin/bash carol

# Warm npm's cache with the pinned dsh so each test run's install is quick.
install -d -m 0700 /var/cache/mu-dsh
HOME=/root npm install --global --prefix /tmp/dsh-warm --no-fund --no-audit \
    --cache /var/cache/mu-dsh/npm "@deepseek-ai/dsh@$DSH_VERSION"
rm -rf /tmp/dsh-warm

# Test boots carry no cloud-init seed; skip cloud-init entirely from now on.
touch /etc/cloud/cloud-init.disabled
apt-get clean
rm -rf /var/lib/apt/lists/*
sync
