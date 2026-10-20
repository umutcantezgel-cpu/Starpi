# Starpi Core on Linux

Two ways to run the companion from an offline bundle (`starpi-companion-<version>.tar.gz`, built
with `node scripts/companion-offline-pack.mjs --out <dir>`). Both need Node.js 22.13 or newer
(the companion uses the built-in `node:sqlite`) and systemd.

| | Per user (default) | System (`--system`) |
| --- | --- | --- |
| Runs as | you, from your user manager | its own account `starpi-companion` |
| Needs root | no | yes |
| Program | `~/.local/opt/starpi-companion` | `/opt/starpi-companion` |
| Launcher | `~/.local/bin/starpi-companion` | `/usr/local/bin/starpi-companion` |
| Units | `~/.config/systemd/user/starpi-companion.service` | `/etc/systemd/system/starpi-companion.service`, `starpi-companion-egress.service` |
| Configuration | `~/.config/starpi-companion/config.json` (optional) | `/etc/starpi-companion/config.json` |
| Data, anchors | `~/.local/share/starpi-companion`, `~/.local/state/starpi-companion/anchors` | `/var/lib/starpi-companion`, `/var/lib/starpi-companion-anchors` |
| Network boundary | the companion's in-process egress guard | the guard, plus `IPAddressDeny=any` and the egress splice |

## Check the bundle first

```sh
sha256sum -c starpi-companion-<version>.tar.gz.sha256
tar -xzf starpi-companion-<version>.tar.gz
cd starpi-companion-<version>
# With the release's public key (compare its id with the release notes):
openssl pkeyutl -verify -pubin -inkey companion-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
sha256sum -c --quiet SHA256SUMS
```

`install.sh` repeats both checks with `deploy/verify-bundle.mjs` (and refuses files that are not
listed). That catches a damaged copy; against a deliberately changed bundle only a check with
tools you already trust helps, because such a bundle can carry a changed checker too.

## Per-user install

```sh
sh deploy/linux/install.sh [--key companion-release.pub] [--enable]
systemctl --user enable --now starpi-companion.service    # unless you passed --enable
starpi-companion pair                                     # a one-time code for the app
loginctl enable-linger "$USER"                            # optional: keep it running after logout
```

The unit is `Type=notify` with `NotifyAccess=all`: the companion reports `READY=1` once its API
listens and pings the watchdog every 10 s while its health check holds (both through
`/usr/bin/systemd-notify`), so `systemctl --user status` shows its own status line and a hung
companion is restarted. A refused start (audit rollback, tampered chain, missing anchors) is not
retried more than five times in five minutes.

Two honest limits of a user unit:

- **No IP firewall.** systemd applies `IPAddressDeny=` only to system services. A user manager
  logs `unit configures an IP firewall, but not running as root` and starts the unit without it,
  so the boundary is the companion's own egress guard (zero egress unless you list hosts). Use the
  system install when you want a boundary outside the process.
- **No namespaces.** Sandboxing that needs mount or user namespaces (`PrivateTmp=`,
  `ProtectSystem=`, ...) is left out, because distributions that restrict unprivileged user
  namespaces would refuse to start the unit. The unit keeps what works without privileges:
  `NoNewPrivileges=`, a system call filter, `RestrictAddressFamilies=` and friends.

### Key in a systemd credential

`--kek systemd-creds` keeps the vault's key-encryption key in an encrypted systemd credential
(host key, TPM2 where present) instead of a key file. It needs systemd 256 or newer (user
credentials). The installer writes `vault.kek` into a new `config.json`, runs
`starpi-companion kek-init` (which calls `systemd-creds --user encrypt`) and adds the drop-in
`starpi-companion.service.d/kek.conf` with `LoadCredentialEncrypted=starpi-companion-kek:...`.
The credential is bound to this machine and backups never hold the key: move data to another
machine with `starpi-companion export` and `import`.

## System install

```sh
sudo sh deploy/linux/install.sh --system [--key companion-release.pub] [--kek systemd-creds]
sudo systemctl enable --now starpi-companion-egress.service starpi-companion.service
sudo starpi-companion pair        # the launcher runs commands as the service account
```

What it sets up:

- **Accounts** from `system/starpi-companion.sysusers` (`systemd-sysusers`): `starpi-companion`
  runs the companion, `starpi-egress` runs the splice, and the group `starpi-egress-client` has
  **no members**.
- **`starpi-companion.service`**: `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30`,
  `IPAddressDeny=any` with `IPAddressAllow=localhost` (the API and local models such as Ollama),
  `SupplementaryGroups=starpi-egress-client`, `ProtectSystem=strict` and the usual hardening, and
  `STARPI_COMPANION_EGRESS_SOCKET=/run/starpi-companion-egress/splice.sock`.
- **`starpi-companion-egress.service`**: `starpi-companion egress-splice --socket ...` as
  `starpi-egress` with primary group `starpi-egress-client`. The socket and its folder belong to
  that group (0660, 0750), so the companion, the only holder of the group, is the only process that
  can connect. The splice reads its host list from a private copy of the configuration
  (`LoadCredential=`), refuses unlisted hosts and any host with a non-public address, connects to
  exactly the checked address and copies ciphertext; it cannot see the companion's data, anchors
  or keys.
- **`/etc/starpi-companion/config.json`** (root:starpi-companion 0640), written only when missing,
  with the data and anchor folders and the key file of the `file` provider in
  `/var/lib/starpi-companion-key` (outside the data folder). With `--kek systemd-creds` the key is
  an encrypted system credential in `/etc/credstore.encrypted/starpi-companion-kek`, loaded by the
  drop-in `starpi-companion.service.d/kek.conf`.

To reach a cloud model, list its host for the `brains` module in `egress.allow` and restart:
`sudo systemctl restart starpi-companion.service` (the splice follows).

Put the anchors on another disk when you can: set `anchorDir` in `config.json` and add a drop-in
with `ReadWritePaths=<folder>` and `RequiresMountsFor=<folder>`.

## Updates, way back, removal

Run the newer bundle's `install.sh` with the same options. It installs the release next to the
current one, switches the `current` link and keeps the previous release; restart the unit
afterwards. To go back, point `current` at the previous folder under `releases/` and restart.

```sh
sh ~/.local/opt/starpi-companion/deploy/uninstall.sh              # keeps configuration and data
sh ~/.local/opt/starpi-companion/deploy/uninstall.sh --purge --yes
sudo sh /opt/starpi-companion/deploy/uninstall.sh [--purge --yes]
```

`--purge --yes` deletes configuration, data, anchors and the key for good.

## Smoke test

`smoke.sh <unpacked bundle>` runs in CI on a runner with a user manager: the companion as a
transient `systemd-run --user` unit (readiness, status line, watchdog pings, `/v1/hello`, clean
stop), then the installed user unit, then `uninstall.sh --purge --yes`. It installs into the
account that runs it, so use it on throwaway machines only.
