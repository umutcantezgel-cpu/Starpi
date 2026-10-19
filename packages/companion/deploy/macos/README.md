# Starpi Core on macOS

The companion runs as a launchd agent of your account. You need Node.js 22.13 or newer (for
example from nodejs.org or Homebrew) and an offline bundle (`starpi-companion-<version>.tar.gz`).

```sh
shasum -a 256 -c starpi-companion-<version>.tar.gz.sha256
tar -xzf starpi-companion-<version>.tar.gz
cd starpi-companion-<version>
sh deploy/macos/install.sh [--key companion-release.pub] [--enable] [--sandbox] [--kek keychain-macos]
starpi-companion pair
```

| | Place |
| --- | --- |
| Program | `~/.local/opt/starpi-companion/releases/<version>` (`current` points at it) |
| Launcher | `~/.local/bin/starpi-companion` |
| Agent | `~/Library/LaunchAgents/app.starpi.companion.plist` |
| Configuration, data, anchors | `~/Library/Application Support/starpi-companion` |
| Log | `~/Library/Logs/starpi-companion/companion.log` |

launchd starts the agent at login (or right away with `--enable`), restarts it after a crash but
not after a clean stop, and waits 30 s for it to stop.

```sh
launchctl print gui/$(id -u)/app.starpi.companion
launchctl kickstart -k gui/$(id -u)/app.starpi.companion     # restart
launchctl bootout gui/$(id -u)/app.starpi.companion          # stop until the next login
```

The bundle's signature can be checked with Node.js, which the companion needs anyway (the openssl
that ships with macOS cannot verify Ed25519):

```sh
node deploy/verify-bundle.mjs . --key companion-release.pub
```

As on Linux, that check catches a damaged copy; for a deliberately changed bundle verify with a
copy of the checker you already trust.

## Key-encryption key

The default `file` provider keeps the vault's key in
`~/Library/Application Support/starpi-companion/kek.key` (0600, outside the data folder).
`--kek keychain-macos` keeps it in your login keychain instead: the installer writes `vault.kek`
into a new `config.json` and runs `starpi-companion kek-init`, which adds a generic password item
`starpi-companion-kek` with the `security` tool.

## Sandbox (preview)

macOS has no per-service IP firewall like systemd's `IPAddressDeny=`. `--sandbox` runs node
through `/usr/bin/sandbox-exec` with `companion.sb`, which keeps the companion from writing outside
its own folders, from starting programs other than node and `security`, from listening anywhere
but loopback, and from connecting anywhere but loopback, the system resolver and port 443. Which
hosts on port 443 is still decided by the companion's egress guard. The profile has not been
verified on hardware yet; if the agent does not start with it, install again without `--sandbox`
and check `companion.log`.

## Log size

launchd does not rotate `companion.log`. To keep it small, add a line for it to
`/etc/newsyslog.d/starpi-companion.conf`, for example:

```text
<your home folder>/Library/Logs/starpi-companion/companion.log  <you>:staff  600  5  1024  *  NJ
```

## Updates and removal

Run the newer bundle's `install.sh` with the same options, then
`launchctl kickstart -k gui/$(id -u)/app.starpi.companion`. The previous release stays under
`releases/` as a way back.

```sh
sh ~/.local/opt/starpi-companion/deploy/uninstall.sh                # keeps configuration and data
sh ~/.local/opt/starpi-companion/deploy/uninstall.sh --purge --yes  # deletes them for good
```
