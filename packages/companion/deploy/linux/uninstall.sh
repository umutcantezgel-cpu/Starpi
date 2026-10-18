#!/bin/sh
# Removes an installation of Starpi Core made by deploy/linux/install.sh: stops and disables its
# units, removes them, the launcher and the program folder. Configuration, data, anchors and the
# vault's key stay where they are unless you pass --purge --yes, which deletes them for good (the
# vault cannot be opened again afterwards).
#
#   sh ~/.local/opt/starpi-companion/deploy/uninstall.sh [--purge --yes]
#   sudo sh /opt/starpi-companion/deploy/uninstall.sh [--purge --yes]
#
# Options:
#   --prefix DIR          the program folder (default: the folder this copy was installed into)
#   --root DIR            the same --root that install.sh was given (packaging and tests)
#   --no-systemctl        do not call systemctl
#   --purge --yes         also delete configuration, data, anchors and the key
set -eu

die() {
  echo "uninstall.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

PREFIX=""
ROOT=""
SYSTEMCTL=1
PURGE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --root) [ $# -ge 2 ] || usage; ROOT=$2; shift 2 ;;
    --no-systemctl) SYSTEMCTL=0; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage ;;
    *) echo "uninstall.sh: unknown option $1" >&2; usage ;;
  esac
done
[ "$PURGE" -eq 0 ] || [ "$YES" -eq 1 ] || die "--purge deletes the vault, its key and the audit anchors for good; confirm with --purge --yes"
[ -z "$ROOT" ] || SYSTEMCTL=0

if [ -z "$PREFIX" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  ENV_FILE=$here/../install.env
else
  ENV_FILE=$ROOT$PREFIX/install.env
fi
[ -f "$ENV_FILE" ] || die "no install.env at $ENV_FILE; pass --prefix <program folder>"

# install.env holds KEY=VALUE lines without spaces; read them without running the file.
value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '"'
}
MODE=$(value MODE)
PREFIX=$(value PREFIX)
BIN_DIR=$(value BIN_DIR)
UNIT_DIR=$(value UNIT_DIR)
CONFIG_DIR=$(value CONFIG_DIR)
CREDENTIAL=$(value CREDENTIAL)
UNITS=$(value UNITS)
case "$MODE" in user|system) ;; *) die "install.env names no mode" ;; esac
for path in "$PREFIX" "$BIN_DIR" "$UNIT_DIR"; do
  case "$path" in /?*) ;; *) die "install.env holds an unusable path: '$path'" ;; esac
done
if [ "$MODE" = system ] && [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then die "this is a system install; run as root"; fi
SCOPE=--user
[ "$MODE" = user ] || SCOPE=--system
R=$ROOT

# Folders the companion used, for --purge: its defaults, plus dataDir and anchorDir of config.json.
purge_targets() {
  if [ "$MODE" = user ]; then
    echo "$CONFIG_DIR"
    echo "${XDG_DATA_HOME:-$HOME/.local/share}/starpi-companion"
    echo "${XDG_STATE_HOME:-$HOME/.local/state}/starpi-companion"
  else
    echo "$CONFIG_DIR"
    echo /var/lib/starpi-companion
    echo /var/lib/starpi-companion-anchors
    echo /var/lib/starpi-companion-key
    echo /etc/sysusers.d/starpi-companion.conf
  fi
  echo "$CREDENTIAL"
  node=$(command -v node 2>/dev/null || true)
  if [ -n "$node" ] && [ -f "$R$CONFIG_DIR/config.json" ]; then
    "$node" -e '
      const { readFileSync } = require("node:fs");
      const { resolve, dirname } = require("node:path");
      const file = process.argv[1];
      try {
        const c = JSON.parse(readFileSync(file, "utf8"));
        for (const k of ["dataDir", "anchorDir"]) if (typeof c[k] === "string") console.log(resolve(dirname(process.argv[2]), c[k]));
      } catch {}
    ' "$R$CONFIG_DIR/config.json" "$CONFIG_DIR/config.json"
  fi
}

if [ "$PURGE" -eq 1 ]; then TARGETS=$(purge_targets); else TARGETS=""; fi

if [ "$SYSTEMCTL" -eq 1 ] && command -v systemctl >/dev/null 2>&1 && [ -n "$UNITS" ]; then
  # shellcheck disable=SC2086 # the unit list is split on purpose
  systemctl "$SCOPE" disable --now $UNITS 2>/dev/null || true
fi
for unit in $UNITS; do rm -f "$R$UNIT_DIR/$unit"; done
rm -f "$R$UNIT_DIR/starpi-companion.service.d/kek.conf"
rmdir "$R$UNIT_DIR/starpi-companion.service.d" 2>/dev/null || true
if [ "$SYSTEMCTL" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl "$SCOPE" daemon-reload 2>/dev/null || true
fi

if [ -f "$R$BIN_DIR/starpi-companion" ] && grep -q 'written by install.sh' "$R$BIN_DIR/starpi-companion"; then
  rm -f "$R$BIN_DIR/starpi-companion"
fi
# Only what install.sh put there; the folder itself goes when nothing else is left in it.
for item in releases current current.new deploy voice-server MANIFEST.json install.env; do
  rm -rf "$R$PREFIX/$item"
done
rmdir "$R$PREFIX" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  printf '%s\n' "$TARGETS" | while IFS= read -r target; do
    case "$target" in /?*/*) rm -rf "$R$target" ;; "") ;; *) echo "skipped unsafe path '$target'" >&2 ;; esac
  done
  [ "$MODE" = user ] || echo "the accounts stay; remove them with: userdel starpi-companion; userdel starpi-egress; groupdel starpi-egress-client"
  echo "Starpi Core removed with its configuration, data, anchors and key."
else
  echo "Starpi Core removed. Configuration, data, anchors and the key are kept (remove them with --purge --yes)."
fi
