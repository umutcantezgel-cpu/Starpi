#!/bin/sh
# Smoke test of Starpi Core under a real systemd user manager (CI on Linux). It needs a running user
# manager (on a CI runner: sudo loginctl enable-linger "$USER" and XDG_RUNTIME_DIR=/run/user/<uid>).
#
#   sh deploy/linux/smoke.sh <unpacked bundle>
#
# 1. systemd-run --user: the companion as a transient Type=notify unit with NotifyAccess=all and a
#    short watchdog; it must become active (READY=1), report its status line, keep pinging the
#    watchdog, answer /v1/hello and stop cleanly.
# 2. The bundle's install.sh for this account, then the installed starpi-companion.service started
#    through systemctl --user, the same checks, and uninstall.sh --purge --yes.
# Step 2 installs into the account that runs it and purges it afterwards: run it on a throwaway
# machine or CI runner only.
set -eu

BUNDLE=${1:?usage: smoke.sh <unpacked bundle>}
BUNDLE=$(cd "$BUNDLE" && pwd)
NODE=$(command -v node)
WORK=$(mktemp -d)
UNIT=starpi-companion-smoke
PORT=47899

fail() {
  echo "smoke: FAILED: $*" >&2
  systemctl --user status "$UNIT.service" starpi-companion.service --no-pager 2>/dev/null || true
  journalctl --user -u "$UNIT.service" -u starpi-companion.service --no-pager -n 80 2>/dev/null || true
  exit 1
}
cleanup() {
  systemctl --user stop "$UNIT.service" 2>/dev/null || true
  systemctl --user reset-failed "$UNIT.service" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

prop() {
  systemctl --user show -p "$2" --value "$1"
}

hello() {
  # shellcheck disable=SC2016 # JavaScript, not shell: the template literal is meant for node
  "$NODE" -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/v1/hello`).then(async (r) => {
      const body = await r.json();
      if (!r.ok || body.name !== "starpi-companion") throw new Error(JSON.stringify(body));
      console.log(`hello: ${body.name} ${body.version}`);
    }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$1"
}

systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ] \
  || fail "no running systemd user manager (loginctl enable-linger, XDG_RUNTIME_DIR)"

echo "== 1. transient unit (systemd-run --user)"
mkdir -p "$WORK/data" "$WORK/anchors" "$WORK/config"
echo '{ "port": 47899 }' > "$WORK/config/config.json"
systemd-run --user --unit="$UNIT" \
  --property=Type=notify --property=NotifyAccess=all --property=WatchdogSec=6 --property=TimeoutStartSec=60 \
  -- "$NODE" "$BUNDLE/app/bin/starpi-companion.mjs" start \
  --config "$WORK/config/config.json" --data-dir "$WORK/data" --anchor-dir "$WORK/anchors" \
  || fail "systemd-run did not start the unit"
[ "$(prop "$UNIT.service" ActiveState)" = active ] || fail "the transient unit is not active"
status=$(prop "$UNIT.service" StatusText)
echo "status: $status"
case "$status" in *"127.0.0.1:$PORT"*) ;; *) fail "unexpected status line '$status'" ;; esac
first=$(prop "$UNIT.service" WatchdogTimestampMonotonic)
sleep 8
[ "$(prop "$UNIT.service" ActiveState)" = active ] || fail "the watchdog stopped the unit"
later=$(prop "$UNIT.service" WatchdogTimestampMonotonic)
[ "$later" -gt "$first" ] || fail "no watchdog ping in 8 s ($first -> $later)"
echo "watchdog: pinged ($first -> $later)"
hello "$PORT" || fail "/v1/hello did not answer"
systemctl --user stop "$UNIT.service"
if systemctl --user is-failed --quiet "$UNIT.service"; then fail "the transient unit failed on stop"; fi

echo "== 2. installed user unit"
sh "$BUNDLE/deploy/linux/install.sh" --prefix "$WORK/opt" --bin-dir "$WORK/bin" --enable || fail "install.sh --enable failed"
[ "$(prop starpi-companion.service ActiveState)" = active ] || fail "starpi-companion.service is not active"
echo "status: $(prop starpi-companion.service StatusText)"
hello 47821 || fail "/v1/hello of the installed unit did not answer"
"$WORK/bin/starpi-companion" status || fail "the launcher's status failed"
systemctl --user stop starpi-companion.service
if systemctl --user is-failed --quiet starpi-companion.service; then fail "starpi-companion.service failed on stop"; fi
sh "$WORK/opt/deploy/uninstall.sh" --purge --yes || fail "uninstall.sh failed"
[ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/starpi-companion.service" ] || fail "the unit file is still there"
[ ! -e "$WORK/opt/current" ] || fail "the program is still there"
echo "smoke: ok"
