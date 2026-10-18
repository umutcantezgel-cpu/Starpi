#!/bin/sh
# Removes an installation of Starpi Core made by deploy/macos/install.sh: unloads the launchd agent
# and removes it, the launcher and the program folder. Configuration, data, anchors, logs and the
# vault's key stay unless you pass --purge --yes, which deletes them for good (the vault cannot be
# opened again afterwards; a keychain item of the keychain-macos provider is removed too).
#
#   sh ~/.local/opt/starpi-companion/deploy/uninstall.sh [--purge --yes]
#
# Options:
#   --prefix DIR          the program folder (default: the folder this copy was installed into)
#   --no-launchctl        do not call launchctl
#   --purge --yes         also delete configuration, data, anchors, logs and the key
set -eu

die() {
  echo "uninstall.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

LABEL=app.starpi.companion
PREFIX=""
LAUNCHCTL=1
PURGE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --no-launchctl) LAUNCHCTL=0; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage ;;
    *) echo "uninstall.sh: unknown option $1" >&2; usage ;;
  esac
done
[ "$PURGE" -eq 0 ] || [ "$YES" -eq 1 ] || die "--purge deletes the vault, its key and the audit anchors for good; confirm with --purge --yes"
: "${HOME:?HOME is not set}"

if [ -z "$PREFIX" ]; then
  ENV_FILE=$(cd "$(dirname "$0")" && pwd)/../install.env
else
  ENV_FILE=$PREFIX/install.env
fi
[ -f "$ENV_FILE" ] || die "no install.env at $ENV_FILE; pass --prefix <program folder>"
value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}
PREFIX=$(value PREFIX)
BIN_DIR=$(value BIN_DIR)
AGENTS_DIR=$(value AGENTS_DIR)
for path in "$PREFIX" "$BIN_DIR" "$AGENTS_DIR"; do
  case "$path" in /?*) ;; *) die "install.env holds an unusable path: '$path'" ;; esac
done
SUPPORT=$HOME/Library/Application\ Support/starpi-companion
LOG_DIR=$HOME/Library/Logs/starpi-companion

if [ "$LAUNCHCTL" -eq 1 ] && command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
rm -f "$AGENTS_DIR/$LABEL.plist"

if [ "$PURGE" -eq 1 ] && [ -f "$SUPPORT/config.json" ] && grep -q '"keychain-macos"' "$SUPPORT/config.json" && command -v security >/dev/null 2>&1; then
  # The provider's default item; a configured service or account name has to be removed by hand.
  security delete-generic-password -s starpi-companion-kek -a starpi-companion >/dev/null 2>&1 || echo "note: no keychain item starpi-companion-kek removed; check Keychain Access" >&2
fi

if [ -f "$BIN_DIR/starpi-companion" ] && grep -q 'written by install.sh' "$BIN_DIR/starpi-companion"; then
  rm -f "$BIN_DIR/starpi-companion"
fi
for item in releases current current.new deploy voice-server MANIFEST.json install.env; do
  rm -rf "$PREFIX/$item"
done
rmdir "$PREFIX" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$SUPPORT" "$LOG_DIR"
  echo "Starpi Core removed with its configuration, data, anchors, logs and key."
else
  echo "Starpi Core removed. Configuration, data, anchors and the key are kept in $SUPPORT (remove them with --purge --yes)."
fi
