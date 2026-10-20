# AGENTS.md: @starpi/companion

The root [AGENTS.md](../../AGENTS.md) applies; this file lists what differs here.

- **Node.js only.** ES modules for Node.js 22.13 or newer (`node:sqlite`), type-checked with this
  folder's `tsconfig.json` (NodeNext, Node.js types) instead of the root one. No browser code and no
  UI strings here; the companion's place in the app lives in `src/js/companion/`.
- **It imports the built `@starpi/core`**, so build that first. From the repository root:
  - `npm run typecheck:companion` and `npm run test:companion` (both run `npm run build:core` first;
    the tests run one file at a time);
  - one test file: `npm run build:core`, then
    `node --test --test-concurrency=1 packages/companion/test/vault.test.mjs`;
  - `node scripts/companion-deps-check.mjs`: every bare import is declared in `package.json`, Node.js
    built-ins use the `node:` prefix, no relative import leaves the package, no computed specifiers,
    and the modules that could spawn processes or open sockets stay in the files that own them;
  - `node scripts/companion-license-check.mjs`: licences of the shipped dependency tree and of the
    voice server's requirements, and the voice allowlist kept identical to the app's;
  - `node --test tests/unit/companion-offline-pack.test.mjs` (after `npm run build:core`): the
    offline bundle and an install from its tarball.
- **Zero egress by default.** The companion listens on loopback only and reaches nothing but this
  machine unless the owner lists a host for a module (`egress.allow`); never open a socket or call
  `fetch` around the egress guard, and never spawn a child process (forbidden in this release).
- **Secrets stay sealed.** Vault items, keys and tokens are sealed at rest and never logged, printed
  or put into audit events in plain text.
- `deploy/` holds the systemd and launchd units and the install scripts. They run from the offline
  bundle before anything is installed, so the JavaScript there imports only `node:` built-ins.
