#!/bin/sh
# Installs Starpi Core (the local companion) on macOS from an unpacked offline bundle, as a launchd
# agent of your account. Run it from the bundle, as yourself (not with sudo):
#
#   sh deploy/macos/install.sh [options]
#
# The program goes to ~/.local/opt/starpi-companion/releases/<version> (with a `current` link), a
# launcher to ~/.local/bin/starpi-companion and the agent to
# ~/Library/LaunchAgents/app.starpi.companion.plist. launchd starts it at your next login, or now
# with --enable. README.md has the details.
#
# Options:
#   --prefix DIR          program folder
#   --bin-dir DIR         launcher folder
#   --agents-dir DIR      folder of the launchd agent (default ~/Library/LaunchAgents)
#   --node PATH           Node.js 22.13 or newer (default: node on PATH)
#   --key FILE            Ed25519 public key (PEM): SHA256SUMS.sig must verify with it
#   --kek PROVIDER        file (default) or keychain-macos: the vault's key-encryption key
#   --sandbox             run node through sandbox-exec with companion.sb (preview)
#   --enable              load and start the agent now
#   --no-launchctl        write the files only (tests, or another machine's layout)
set -eu

die() {
  echo "install.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

LABEL=app.starpi.companion
PREFIX=""
BIN_DIR=""
AGENTS_DIR=""
NODE=""
KEY=""
KEK="file"
SANDBOX=0
ENABLE=0
LAUNCHCTL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || usage; BIN_DIR=$2; shift 2 ;;
    --agents-dir) [ $# -ge 2 ] || usage; AGENTS_DIR=$2; shift 2 ;;
    --node) [ $# -ge 2 ] || usage; NODE=$2; shift 2 ;;
    --key) [ $# -ge 2 ] || usage; KEY=$2; shift 2 ;;
    --kek) [ $# -ge 2 ] || usage; KEK=$2; shift 2 ;;
    --sandbox) SANDBOX=1; shift ;;
    --enable) ENABLE=1; shift ;;
    --no-launchctl) LAUNCHCTL=0; shift ;;
    -h|--help) usage ;;
    *) echo "install.sh: unknown option $1" >&2; usage ;;
  esac
done

case "$KEK" in file|keychain-macos) ;; *) die "--kek is file or keychain-macos" ;; esac
if [ "$LAUNCHCTL" -eq 1 ]; then
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS; on Linux use deploy/linux/install.sh"
else
  [ "$ENABLE" -eq 0 ] || die "--enable needs launchctl"
fi
[ "$LAUNCHCTL" -eq 0 ] || [ "$(id -u)" -ne 0 ] || die "install as yourself, not as root: the agent runs in your account"
: "${HOME:?HOME is not set}"

HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(cd "$HERE/../.." && pwd)
[ -f "$BUNDLE/app/bin/starpi-companion.mjs" ] && [ -f "$BUNDLE/MANIFEST.json" ] && [ -f "$BUNDLE/deploy/verify-bundle.mjs" ] \
  || die "$BUNDLE is not an unpacked bundle (app/, MANIFEST.json, deploy/); build one with scripts/companion-offline-pack.mjs"

if [ -z "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null) || die "Node.js not found; install Node.js 22.13 or newer, or pass --node"
fi
case "$NODE" in /*) ;; *) NODE=$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE") ;; esac
[ -x "$NODE" ] || die "$NODE is not executable"
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || die "Node.js $("$NODE" -v) is too old; the companion needs 22.13 or newer (node:sqlite)"

if [ -n "$KEY" ]; then
  [ -f "$KEY" ] || die "the key file $KEY does not exist"
  "$NODE" "$BUNDLE/deploy/verify-bundle.mjs" "$BUNDLE" --key "$KEY" || die "the bundle does not verify; NOT installed"
else
  "$NODE" "$BUNDLE/deploy/verify-bundle.mjs" "$BUNDLE" || die "the bundle does not verify; NOT installed"
  [ ! -f "$BUNDLE/SHA256SUMS.sig" ] || echo "note: the bundle is signed; pass --key <public key> to check the signature as well" >&2
fi
VERSION=$("$NODE" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$BUNDLE/MANIFEST.json")
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "MANIFEST.json names no usable version"

PREFIX=${PREFIX:-$HOME/.local/opt/starpi-companion}
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
AGENTS_DIR=${AGENTS_DIR:-$HOME/Library/LaunchAgents}
SUPPORT=$HOME/Library/Application\ Support/starpi-companion
LOG_DIR=$HOME/Library/Logs/starpi-companion
APP=$PREFIX/current
for path in "$PREFIX" "$BIN_DIR" "$AGENTS_DIR" "$NODE"; do
  case "$path" in /*) ;; *) die "$path is not an absolute path" ;; esac
  case "$path" in *"'"*|*'"'*|*\\*|*'$'*|*'`'*) die "$path holds quotes or shell characters; choose another folder" ;; esac
done

# --- Program ----------------------------------------------------------------------------------
mkdir -p "$PREFIX/releases"
previous=""
if [ -L "$PREFIX/current" ]; then previous=$(basename "$(readlink "$PREFIX/current")"); fi
rm -rf "$PREFIX/releases/$VERSION.new"
cp -R "$BUNDLE/app" "$PREFIX/releases/$VERSION.new"
rm -rf "$PREFIX/releases/$VERSION"
mv "$PREFIX/releases/$VERSION.new" "$PREFIX/releases/$VERSION"
rm -f "$PREFIX/current.new"
ln -s "releases/$VERSION" "$PREFIX/current.new"
# rename(2) replaces the old link in one step (mv -f on macOS would follow a link to a folder).
"$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$PREFIX/current.new" "$PREFIX/current"
for old in "$PREFIX"/releases/*; do
  name=$(basename "$old")
  [ "$name" = "$VERSION" ] || [ "$name" = "$previous" ] || rm -rf "$old"
done
mkdir -p "$PREFIX/deploy"
cp "$HERE/uninstall.sh" "$HERE/README.md" "$HERE/companion.sb" "$PREFIX/deploy/"
cp "$BUNDLE/MANIFEST.json" "$PREFIX/MANIFEST.json"
if [ -d "$BUNDLE/voice-server" ]; then
  rm -rf "$PREFIX/voice-server"
  cp -R "$BUNDLE/voice-server" "$PREFIX/voice-server"
fi
{
  echo "# Written by install.sh; read by deploy/uninstall.sh."
  echo "PREFIX=$PREFIX"
  echo "BIN_DIR=$BIN_DIR"
  echo "AGENTS_DIR=$AGENTS_DIR"
  echo "VERSION=$VERSION"
} > "$PREFIX/install.env"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/starpi-companion.new" <<EOF
#!/bin/sh
# Launcher of Starpi Core (the local companion), written by install.sh.
exec '$NODE' '$APP/bin/starpi-companion.mjs' "\$@"
EOF
chmod 0755 "$BIN_DIR/starpi-companion.new"
mv -f "$BIN_DIR/starpi-companion.new" "$BIN_DIR/starpi-companion"

# --- Key-encryption key -----------------------------------------------------------------------
if [ "$KEK" = keychain-macos ]; then
  mkdir -p "$SUPPORT"
  if [ -f "$SUPPORT/config.json" ]; then
    grep -q '"keychain-macos"' "$SUPPORT/config.json" \
      || die "$SUPPORT/config.json exists without vault.kek provider keychain-macos; add { \"vault\": { \"kek\": { \"provider\": \"keychain-macos\" } } } and run again"
  else
    cat > "$SUPPORT/config.json" <<'EOF'
{
  "$comment": "Written by install.sh --kek keychain-macos. Every member is optional; see the companion's README.",
  "vault": { "kek": { "provider": "keychain-macos" } }
}
EOF
    chmod 0600 "$SUPPORT/config.json"
    "$NODE" "$APP/bin/starpi-companion.mjs" kek-init || die "kek-init failed; the program is installed, the agent is not"
  fi
fi

# --- Agent ------------------------------------------------------------------------------------
xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
arg() {
  printf '    <string>%s</string>\n' "$(xml "$1")"
}
ARGS=$(mktemp)
trap 'rm -f "$ARGS"' EXIT
if [ "$SANDBOX" -eq 1 ]; then
  # The sandbox matches the program a process runs by its real path, so links are resolved first.
  NODE=$("$NODE" -p 'require("node:fs").realpathSync(process.execPath)')
fi
{
  if [ "$SANDBOX" -eq 1 ]; then
    arg /usr/bin/sandbox-exec
    arg -f
    arg "$PREFIX/deploy/companion.sb"
    arg -D
    arg "NODE=$NODE"
    arg -D
    arg "HOME=$HOME"
    arg -D
    arg "SUPPORT=$SUPPORT"
    arg -D
    arg "LOGS=$LOG_DIR"
  fi
  arg "$NODE"
  arg "$APP/bin/starpi-companion.mjs"
  arg start
} > "$ARGS"
mkdir -p "$AGENTS_DIR" "$LOG_DIR"
PLIST=$AGENTS_DIR/$LABEL.plist
# The placeholders are replaced with escaped values; @PROGRAM_ARGUMENTS@ by the lines above.
app_xml=$(xml "$APP" | sed -e 's/[|&\\]/\\&/g')
log_xml=$(xml "$LOG_DIR" | sed -e 's/[|&\\]/\\&/g')
sed -e "/@PROGRAM_ARGUMENTS@/{r $ARGS" -e 'd' -e '}' -e "s|@APP@|$app_xml|g" -e "s|@LOG_DIR@|$log_xml|g" \
  "$HERE/app.starpi.companion.plist" > "$PLIST.new"
chmod 0644 "$PLIST.new"
mv -f "$PLIST.new" "$PLIST"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$PLIST" >/dev/null || die "$PLIST is not a valid property list"; fi

if [ "$LAUNCHCTL" -eq 1 ] && [ "$ENABLE" -eq 1 ]; then
  domain=gui/$(id -u)
  launchctl bootout "$domain/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$domain" "$PLIST"
  launchctl enable "$domain/$LABEL"
fi

echo "Starpi Core $VERSION installed: $PREFIX/releases/$VERSION"
echo "  launcher  $BIN_DIR/starpi-companion"
echo "  agent     $PLIST$([ "$SANDBOX" -eq 1 ] && echo ' (sandboxed, preview)')"
echo "  log       $LOG_DIR/companion.log"
[ "$ENABLE" -eq 1 ] || echo "next: launchctl bootstrap gui/\$(id -u) '$PLIST' && starpi-companion pair   (or log in again)"
echo "uninstall: sh '$PREFIX/deploy/uninstall.sh'"
