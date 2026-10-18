#!/bin/sh
# Installs Starpi Core (the local companion) on Linux from an unpacked offline bundle. Run it from
# the bundle, not from the repository:
#
#   sh deploy/linux/install.sh [options]              per-user install (default, no root)
#   sudo sh deploy/linux/install.sh --system [options]
#
# Per user: the program goes to ~/.local/opt/starpi-companion/releases/<version> (with a `current`
# link), a launcher to ~/.local/bin/starpi-companion and a systemd user unit to
# ~/.config/systemd/user/. System (--system): the same below /opt/starpi-companion and
# /usr/local/bin, the accounts of starpi-companion.sysusers, /etc/starpi-companion/config.json and
# two system units: the companion under IPAddressDeny=any and the egress splice whose socket only
# the companion can open. Nothing is enabled unless you pass --enable. README.md has the details.
#
# Options:
#   --system              system install (root); default is the per-user install
#   --prefix DIR          program folder
#   --bin-dir DIR         launcher folder
#   --unit-dir DIR        systemd unit folder
#   --root DIR            system install below DIR (packaging and tests): no accounts or
#                         ownership on this machine, no systemctl; accounts go to DIR/etc
#   --node PATH           Node.js 22.13 or newer (default: node on PATH)
#   --key FILE            Ed25519 public key (PEM): SHA256SUMS.sig must verify with it
#   --kek PROVIDER        file (default) or systemd-creds: the vault's key-encryption key
#   --enable              enable and start the unit(s) after installing
#   --no-systemctl        do not call systemctl (install now, start later)
set -eu

die() {
  echo "install.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

MODE=user
PREFIX=""
BIN_DIR=""
UNIT_DIR=""
ROOT=""
NODE=""
KEY=""
KEK=file
ENABLE=0
SYSTEMCTL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --system) MODE=system; shift ;;
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || usage; BIN_DIR=$2; shift 2 ;;
    --unit-dir) [ $# -ge 2 ] || usage; UNIT_DIR=$2; shift 2 ;;
    --root) [ $# -ge 2 ] || usage; ROOT=$2; shift 2 ;;
    --node) [ $# -ge 2 ] || usage; NODE=$2; shift 2 ;;
    --key) [ $# -ge 2 ] || usage; KEY=$2; shift 2 ;;
    --kek) [ $# -ge 2 ] || usage; KEK=$2; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --no-systemctl) SYSTEMCTL=0; shift ;;
    -h|--help) usage ;;
    *) echo "install.sh: unknown option $1" >&2; usage ;;
  esac
done

case "$KEK" in file|systemd-creds) ;; *) die "--kek is file or systemd-creds" ;; esac
[ "$(uname -s)" = Linux ] || die "this installer is for Linux; on macOS use deploy/macos/install.sh"
if [ -n "$ROOT" ]; then
  [ "$MODE" = system ] || die "--root goes with --system"
  case "$ROOT" in /*) ;; *) die "--root must be an absolute path" ;; esac
  SYSTEMCTL=0
  [ "$ENABLE" -eq 0 ] || die "--enable cannot be used with --root"
fi

HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(cd "$HERE/../.." && pwd)
[ -f "$BUNDLE/app/bin/starpi-companion.mjs" ] && [ -f "$BUNDLE/MANIFEST.json" ] && [ -f "$BUNDLE/deploy/verify-bundle.mjs" ] \
  || die "$BUNDLE is not an unpacked bundle (app/, MANIFEST.json, deploy/); build one with scripts/companion-offline-pack.mjs"

# --- Node.js ----------------------------------------------------------------------------------
if [ -z "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null) || die "Node.js not found; install Node.js 22.13 or newer, or pass --node"
fi
case "$NODE" in /*) ;; *) NODE=$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE") ;; esac
[ -x "$NODE" ] || die "$NODE is not executable"
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || die "Node.js $("$NODE" -v) is too old; the companion needs 22.13 or newer (node:sqlite)"

# --- The bundle -------------------------------------------------------------------------------
if [ -n "$KEY" ]; then
  [ -f "$KEY" ] || die "the key file $KEY does not exist"
  "$NODE" "$BUNDLE/deploy/verify-bundle.mjs" "$BUNDLE" --key "$KEY" || die "the bundle does not verify; NOT installed"
else
  "$NODE" "$BUNDLE/deploy/verify-bundle.mjs" "$BUNDLE" || die "the bundle does not verify; NOT installed"
  if [ -f "$BUNDLE/SHA256SUMS.sig" ]; then
    echo "note: the bundle is signed; pass --key <public key> to check the signature as well" >&2
  fi
fi
VERSION=$("$NODE" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$BUNDLE/MANIFEST.json")
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "MANIFEST.json names no usable version"

# --- Places -----------------------------------------------------------------------------------
if [ "$MODE" = user ]; then
  : "${HOME:?HOME is not set}"
  CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
  PREFIX=${PREFIX:-$HOME/.local/opt/starpi-companion}
  BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
  UNIT_DIR=${UNIT_DIR:-$CONFIG_HOME/systemd/user}
  # The companion's own default for this account (the unit passes no --config).
  CONFIG_DIR=$CONFIG_HOME/starpi-companion
  CREDENTIAL=$CONFIG_HOME/credstore.encrypted/starpi-companion-kek
  SYSTEMCTL_SCOPE=--user
else
  [ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || die "--system needs root (sudo sh deploy/linux/install.sh --system)"
  PREFIX=${PREFIX:-/opt/starpi-companion}
  BIN_DIR=${BIN_DIR:-/usr/local/bin}
  UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
  CONFIG_DIR=/etc/starpi-companion
  CREDENTIAL=/etc/credstore.encrypted/starpi-companion-kek
  SYSTEMCTL_SCOPE=--system
fi

# Paths end up in unit files and sed replacements, so they keep to a plain alphabet.
for path in "$PREFIX" "$BIN_DIR" "$UNIT_DIR" "$CONFIG_DIR" "$NODE" "$CREDENTIAL"; do
  case "$path" in /*) ;; *) die "$path is not an absolute path" ;; esac
  printf '%s\n' "$path" | grep -Eq '^[A-Za-z0-9._/@+-]+$' \
    || die "$path holds characters a unit file cannot take as they are (spaces, quotes, %, \$); choose another folder"
done
APP=$PREFIX/current
# Below --root every path gets the prefix; the files keep naming the final places.
R=$ROOT

# --- Program ----------------------------------------------------------------------------------
mkdir -p "$R$PREFIX/releases"
previous=""
if [ -L "$R$PREFIX/current" ]; then previous=$(basename "$(readlink "$R$PREFIX/current")"); fi
rm -rf "$R$PREFIX/releases/$VERSION.new"
cp -R "$BUNDLE/app" "$R$PREFIX/releases/$VERSION.new"
rm -rf "$R$PREFIX/releases/$VERSION"
mv "$R$PREFIX/releases/$VERSION.new" "$R$PREFIX/releases/$VERSION"
ln -sfn "releases/$VERSION" "$R$PREFIX/current.new"
mv -Tf "$R$PREFIX/current.new" "$R$PREFIX/current"
# Keep the release before this one for a quick way back; older ones go.
for old in "$R$PREFIX"/releases/*; do
  name=$(basename "$old")
  [ "$name" = "$VERSION" ] || [ "$name" = "$previous" ] || rm -rf "$old"
done
mkdir -p "$R$PREFIX/deploy"
cp "$HERE/uninstall.sh" "$HERE/README.md" "$R$PREFIX/deploy/"
cp "$BUNDLE/MANIFEST.json" "$R$PREFIX/MANIFEST.json"
if [ -d "$BUNDLE/voice-server" ]; then
  rm -rf "$R$PREFIX/voice-server"
  cp -R "$BUNDLE/voice-server" "$R$PREFIX/voice-server"
fi

# What uninstall.sh needs to know.
{
  echo "# Written by install.sh; read by deploy/uninstall.sh."
  echo "MODE=$MODE"
  echo "PREFIX=$PREFIX"
  echo "BIN_DIR=$BIN_DIR"
  echo "UNIT_DIR=$UNIT_DIR"
  echo "CONFIG_DIR=$CONFIG_DIR"
  echo "CREDENTIAL=$CREDENTIAL"
  echo "VERSION=$VERSION"
} > "$R$PREFIX/install.env"

# --- Launcher ---------------------------------------------------------------------------------
mkdir -p "$R$BIN_DIR"
if [ "$MODE" = user ]; then
  cat > "$R$BIN_DIR/starpi-companion.new" <<EOF
#!/bin/sh
# Launcher of Starpi Core (the local companion), written by install.sh.
exec '$NODE' '$APP/bin/starpi-companion.mjs' "\$@"
EOF
else
  cat > "$R$BIN_DIR/starpi-companion.new" <<EOF
#!/bin/sh
# Launcher of Starpi Core (the local companion, system install), written by install.sh. Commands use
# the system configuration and, started by root, run as the service account, so files in the data
# folder keep their owner.
STARPI_COMPANION_CONFIG=$CONFIG_DIR/config.json
export STARPI_COMPANION_CONFIG
if [ "\$(id -u)" -eq 0 ] && [ "\${1:-}" != kek-init ]; then
  exec runuser -u starpi-companion -- '$NODE' '$APP/bin/starpi-companion.mjs' "\$@"
fi
exec '$NODE' '$APP/bin/starpi-companion.mjs' "\$@"
EOF
fi
chmod 0755 "$R$BIN_DIR/starpi-companion.new"
mv -f "$R$BIN_DIR/starpi-companion.new" "$R$BIN_DIR/starpi-companion"

# --- Accounts and configuration ---------------------------------------------------------------
write_config() {
  # $1: file. Only written when missing: an existing configuration is never touched.
  if [ "$MODE" = system ]; then
    if [ "$KEK" = systemd-creds ]; then
      kek="{ \"provider\": \"systemd-creds\", \"credential\": \"$CREDENTIAL\", \"user\": false }"
    else
      kek="{ \"provider\": \"file\", \"path\": \"/var/lib/starpi-companion-key/kek.key\" }"
    fi
    cat > "$1" <<EOF
{
  "\$comment": "Written by install.sh --system. Every member is optional; see the companion's README.",
  "dataDir": "/var/lib/starpi-companion",
  "anchorDir": "/var/lib/starpi-companion-anchors",
  "vault": { "kek": $kek },
  "egress": { "allow": {} }
}
EOF
  else
    cat > "$1" <<EOF
{
  "\$comment": "Written by install.sh --kek systemd-creds. Every member is optional; see the companion's README.",
  "vault": { "kek": { "provider": "systemd-creds", "credential": "$CREDENTIAL" } }
}
EOF
  fi
}

if [ "$MODE" = system ]; then
  mkdir -p "$R/etc/sysusers.d"
  cp "$HERE/system/starpi-companion.sysusers" "$R/etc/sysusers.d/starpi-companion.conf"
  if [ -n "$ROOT" ]; then
    # Below --root the accounts are a courtesy for image builds; the target creates them at boot.
    if command -v systemd-sysusers >/dev/null 2>&1; then
      systemd-sysusers --root="$ROOT" starpi-companion.conf || echo "note: systemd-sysusers --root failed; the accounts are made when the target boots" >&2
    fi
  else
    command -v systemd-sysusers >/dev/null 2>&1 || die "systemd-sysusers is missing; the system install needs systemd"
    systemd-sysusers starpi-companion.conf
  fi
  mkdir -p "$R$CONFIG_DIR"
  [ -f "$R$CONFIG_DIR/config.json" ] || write_config "$R$CONFIG_DIR/config.json"
  if [ -z "$ROOT" ]; then
    chown -R root:root "$PREFIX"
    chown root:starpi-companion "$CONFIG_DIR" "$CONFIG_DIR/config.json"
  fi
  chmod 0750 "$R$CONFIG_DIR"
  chmod 0640 "$R$CONFIG_DIR/config.json"
elif [ "$KEK" = systemd-creds ]; then
  mkdir -p "$CONFIG_DIR"
  if [ -f "$CONFIG_DIR/config.json" ]; then
    grep -q '"systemd-creds"' "$CONFIG_DIR/config.json" \
      || die "$CONFIG_DIR/config.json exists without vault.kek provider systemd-creds; add { \"vault\": { \"kek\": { \"provider\": \"systemd-creds\", \"credential\": \"$CREDENTIAL\" } } } and run again"
  else
    write_config "$CONFIG_DIR/config.json"
    chmod 0600 "$CONFIG_DIR/config.json"
  fi
fi

# The key-encryption key as an encrypted credential: made once, before the unit can load it.
if [ "$KEK" = systemd-creds ] && [ -z "$ROOT" ] && [ ! -f "$CREDENTIAL" ]; then
  mkdir -p "$(dirname "$CREDENTIAL")"
  chmod 0700 "$(dirname "$CREDENTIAL")"
  if [ "$MODE" = system ]; then
    STARPI_COMPANION_CONFIG=$CONFIG_DIR/config.json "$NODE" "$APP/bin/starpi-companion.mjs" kek-init \
      || die "kek-init failed (systemd-creds needs systemd 250 or newer); the program is installed, the units are not"
  else
    "$NODE" "$APP/bin/starpi-companion.mjs" kek-init \
      || die "kek-init failed (user credentials need systemd 256 or newer; or use the default --kek file); the program is installed, the unit is not"
  fi
fi

# --- Units ------------------------------------------------------------------------------------
render() {
  # $1: template, $2: target
  sed -e "s|@NODE@|$NODE|g" -e "s|@APP@|$APP|g" -e "s|@CREDENTIAL@|$CREDENTIAL|g" "$1" > "$2.new"
  chmod 0644 "$2.new"
  mv -f "$2.new" "$2"
}

mkdir -p "$R$UNIT_DIR"
if [ "$MODE" = user ]; then
  UNITS="starpi-companion.service"
  render "$HERE/user/starpi-companion.service" "$R$UNIT_DIR/starpi-companion.service"
  DROPIN_SOURCE=$HERE/user/kek-systemd-creds.conf
else
  UNITS="starpi-companion-egress.service starpi-companion.service"
  render "$HERE/system/starpi-companion.service" "$R$UNIT_DIR/starpi-companion.service"
  render "$HERE/system/starpi-companion-egress.service" "$R$UNIT_DIR/starpi-companion-egress.service"
  DROPIN_SOURCE=$HERE/system/kek-systemd-creds.conf
fi
if [ "$KEK" = systemd-creds ]; then
  mkdir -p "$R$UNIT_DIR/starpi-companion.service.d"
  render "$DROPIN_SOURCE" "$R$UNIT_DIR/starpi-companion.service.d/kek.conf"
else
  rm -f "$R$UNIT_DIR/starpi-companion.service.d/kek.conf"
  rmdir "$R$UNIT_DIR/starpi-companion.service.d" 2>/dev/null || true
fi
echo "UNITS=\"$UNITS\"" >> "$R$PREFIX/install.env"

if [ "$SYSTEMCTL" -eq 1 ]; then
  if systemctl "$SYSTEMCTL_SCOPE" daemon-reload; then
    if [ "$ENABLE" -eq 1 ]; then
      # shellcheck disable=SC2086 # the unit list is split on purpose
      systemctl "$SYSTEMCTL_SCOPE" enable --now $UNITS
    fi
  else
    echo "note: systemctl $SYSTEMCTL_SCOPE daemon-reload failed (no running manager?); run it before starting the unit" >&2
  fi
fi

echo "Starpi Core $VERSION installed ($MODE): $R$PREFIX/releases/$VERSION"
echo "  launcher  $R$BIN_DIR/starpi-companion"
echo "  units     $R$UNIT_DIR ($UNITS)"
if [ "$ENABLE" -eq 0 ]; then
  if [ "$MODE" = user ]; then
    echo "next: systemctl --user enable --now starpi-companion.service && starpi-companion pair"
  else
    echo "next: systemctl enable --now starpi-companion-egress.service starpi-companion.service && starpi-companion pair"
  fi
fi
echo "uninstall: sh $PREFIX/deploy/uninstall.sh"
