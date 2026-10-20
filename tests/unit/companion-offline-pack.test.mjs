// Offline bundle of the local companion (scripts/companion-offline-pack.mjs and
// packages/companion/deploy/verify-bundle.mjs) and the install scripts of deploy/linux and
// deploy/macos: a bundle built from this checkout, signed and checked, unpacked from its tarball
// and installed into a temporary folder, where the installed companion starts and answers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundlePathOf, companionDependencies, main, packOffline, splitTarPath } from '../../scripts/companion-offline-pack.mjs';
import { readLockfile } from '../../scripts/license-gate.mjs';
import { isBundlePath, parseSums, SIGNATURE, SUMS, verifyBundle } from '../../packages/companion/deploy/verify-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LINUX = process.platform === 'linux';
const scratch = mkdtempSync(path.join(tmpdir(), 'companion-pack-'));
const signer = generateKeyPairSync('ed25519');
const PRIVATE = signer.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_FILE = path.join(scratch, 'release.pub');
writeFileSync(PUBLIC_FILE, signer.publicKey.export({ type: 'spki', format: 'pem' }));
const OTHER_PUBLIC = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
const EPOCH = 1_790_000_000;

/** @type {ReturnType<typeof packOffline>} */
let packed;
before(() => {
  // The bundle carries the built @starpi/core; a fresh checkout (npm test before any build) has
  // no packages/core/dist yet, so it is built here as npm run build:core would.
  if (!existsSync(path.join(ROOT, 'packages/core/dist/index.js'))) {
    const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-core.mjs')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(built.status, 0, built.stderr);
  }
  packed = packOffline({ outDir: path.join(scratch, 'out'), signKey: PRIVATE, now: EPOCH });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** @param {string} cmd @param {string[]} args @param {{ env?: NodeJS.ProcessEnv, cwd?: string, input?: string }} [options] */
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...options });
// A program is there when it starts; no shell reads its name.
const has = (/** @type {string} */ cmd) => !run(cmd, ['--version']).error;

/** An environment for the install scripts with HOME (and nothing of the real one) in `home`. */
function homeEnv(/** @type {string} */ home) {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, LANG: 'C' };
}

/** Unpacks the tarball into a new folder and returns the bundle folder. */
function unpack(/** @type {string} */ name) {
  const into = path.join(scratch, name);
  mkdirSync(into, { recursive: true });
  const out = run('tar', ['-xzf', /** @type {string} */ (packed.tarball), '-C', into]);
  assert.equal(out.status, 0, out.stderr);
  return path.join(into, `starpi-companion-${packed.version}`);
}

/** @returns {Promise<number>} */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(address.port));
    });
  });

describe('the bundle', () => {
  it('lists the production dependencies through the lockfile', () => {
    const { deps, problems } = companionDependencies(readLockfile(ROOT));
    assert.deepEqual(problems, []);
    assert.ok(deps.some((d) => d.name === '@anthropic-ai/sdk' && d.dest === 'node_modules/@anthropic-ai/sdk'));
    assert.equal(bundlePathOf('packages/companion/node_modules/a'), 'node_modules/a');
    assert.equal(bundlePathOf('node_modules/a/node_modules/b'), 'node_modules/a/node_modules/b');
    assert.equal(bundlePathOf('packages/other'), null);
  });

  it('holds the program, its dependencies, the deploy files and the voice server, all listed and signed', () => {
    const dir = packed.dir;
    for (const rel of ['app/package.json', 'app/bin/starpi-companion.mjs', 'app/src/service.js', 'app/LICENSE', 'app/NOTICE', 'app/node_modules/@anthropic-ai/sdk/package.json', 'deploy/verify-bundle.mjs', 'deploy/linux/install.sh', 'deploy/linux/user/starpi-companion.service', 'deploy/linux/system/starpi-companion-egress.service', 'deploy/macos/app.starpi.companion.plist', 'voice-server/server.py', 'voice-server/allowlist.json', 'MANIFEST.json', SUMS, SIGNATURE]) {
      assert.ok(existsSync(path.join(dir, rel)), `${rel} is missing`);
    }
    for (const rel of ['app/test', 'app/deploy', 'voice-server/test_server.py', 'app/node_modules/.bin']) assert.ok(!existsSync(path.join(dir, rel)), `${rel} should not ship`);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
    assert.equal(manifest.version, packed.version);
    assert.equal(manifest.created, new Date(EPOCH * 1000).toISOString());
    assert.ok(manifest.dependencies.every((/** @type {any} */ d) => typeof d.license === 'string'));
    const { entries, problems } = parseSums(readFileSync(path.join(dir, SUMS), 'utf8'));
    assert.deepEqual(problems, []);
    assert.equal(entries.size, packed.files - 2);
    assert.deepEqual(verifyBundle(dir, { publicKey: readFileSync(PUBLIC_FILE) }), { ok: true, problems: [], files: entries.size, signed: true, keyId: packed.keyId });
    const wrong = verifyBundle(dir, { publicKey: OTHER_PUBLIC });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems[0], /not a valid signature/);
    assert.equal(verifyBundle(dir).ok, true);
  });

  it('refuses a changed, missing, unlisted or linked file and a path that leaves the bundle', () => {
    const copy = path.join(scratch, 'tampered');
    cpSync(packed.dir, copy, { recursive: true });
    appendFileSync(path.join(copy, 'app/src/service.js'), '\n// changed\n');
    unlinkSync(path.join(copy, 'deploy/linux/uninstall.sh'));
    writeFileSync(path.join(copy, 'app/extra.js'), 'export {};\n');
    symlinkSync('/etc/hostname', path.join(copy, 'app/link'));
    const report = verifyBundle(copy, { publicKey: readFileSync(PUBLIC_FILE) });
    assert.equal(report.ok, false);
    const text = report.problems.join('\n');
    for (const expected of [/app\/src\/service\.js does not match/, /deploy\/linux\/uninstall\.sh is missing/, /app\/extra\.js is not listed/, /app\/link is a symbolic link/]) assert.match(text, expected);
    writeFileSync(path.join(copy, SUMS), `${'0'.repeat(64)}  ../outside\n`);
    assert.match(verifyBundle(copy).problems.join('\n'), /leaves the bundle/);
    rmSync(path.join(copy, SUMS));
    assert.deepEqual(verifyBundle(copy).problems, [`${SUMS} is missing`]);
    assert.equal(isBundlePath('a/./b'), false);
    assert.equal(isBundlePath('a b/c'), true);
  });

  it('writes the same tarball twice and it unpacks to a bundle that checks out', () => {
    const again = packOffline({ outDir: path.join(scratch, 'again'), signKey: PRIVATE, now: EPOCH });
    assert.equal(again.sha256, packed.sha256);
    assert.equal(readFileSync(`${packed.tarball}.sha256`, 'utf8'), `${packed.sha256}  starpi-companion-${packed.version}.tar.gz\n`);
    const unpacked = unpack('unpacked');
    assert.equal(verifyBundle(unpacked, { publicKey: readFileSync(PUBLIC_FILE) }).ok, true);
    const listing = run('tar', ['-tvzf', /** @type {string} */ (packed.tarball)]).stdout.split('\n');
    assert.ok(listing.some((line) => /^-rwxr-xr-x .*deploy\/linux\/install\.sh$/.test(line)), 'install.sh keeps its executable bit');
  });

  it('splits long paths for ustar', () => {
    assert.deepEqual(splitTarPath('short/name'), { name: 'short/name', prefix: '' });
    const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}`;
    const split = splitTarPath(long);
    assert.ok(split && split.prefix.length <= 155 && split.name.length <= 100 && `${split.prefix}/${split.name}` === long);
    assert.equal(splitTarPath('x'.repeat(120)), null);
  });

  it('answers usage errors on the command line', () => {
    const stderr = process.stderr.write;
    process.stderr.write = () => true;
    try {
      assert.equal(main([]), 2);
      assert.equal(main(['keygen']), 2);
    } finally {
      process.stderr.write = stderr;
    }
  });
});

describe('the Linux install scripts', { skip: !LINUX && 'Linux only' }, () => {
  it('install per user from the tarball; the installed companion starts and answers; uninstall removes it', async () => {
    const bundle = unpack('linux-user');
    const home = path.join(scratch, 'home-user');
    mkdirSync(home);
    const env = homeEnv(home);
    const install = run('sh', [path.join(bundle, 'deploy/linux/install.sh'), '--key', PUBLIC_FILE, '--no-systemctl'], { env });
    assert.equal(install.status, 0, install.stderr + install.stdout);
    assert.match(install.stdout, /signature valid/);
    const prefix = path.join(home, '.local/opt/starpi-companion');
    const unit = readFileSync(path.join(home, '.config/systemd/user/starpi-companion.service'), 'utf8');
    assert.doesNotMatch(unit, /@[A-Z_]+@/);
    assert.match(unit, new RegExp(`^ExecStart=${process.execPath} ${prefix}/current/bin/starpi-companion\\.mjs start$`, 'm'));
    for (const line of ['Type=notify', 'NotifyAccess=all', 'WatchdogSec=30', 'IPAddressDeny=any']) assert.match(unit, new RegExp(`^${line}$`, 'm'));
    const launcher = path.join(home, '.local/bin/starpi-companion');
    assert.equal(run(launcher, ['version'], { env }).stdout.trim(), packed.version);
    const resolved = run(process.execPath, ['-e', 'console.log(require.resolve("@anthropic-ai/sdk"))'], { cwd: path.join(prefix, 'current'), env });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.ok(resolved.stdout.startsWith(path.join(prefix, 'releases', packed.version, 'node_modules')));

    const port = await freePort();
    const child = spawn(launcher, ['start', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    let hello = null;
    for (let i = 0; i < 100 && hello === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      hello = await fetch(`http://127.0.0.1:${port}/v1/hello`).then((r) => r.json(), () => null);
    }
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(/** @type {any} */ (hello)?.name, 'starpi-companion');
    assert.ok(existsSync(path.join(home, '.local/share/starpi-companion/companion.db')));

    const kept = run('sh', [path.join(prefix, 'deploy/uninstall.sh'), '--no-systemctl'], { env });
    assert.equal(kept.status, 0, kept.stderr);
    assert.ok(!existsSync(prefix) && !existsSync(launcher) && !existsSync(path.join(home, '.config/systemd/user/starpi-companion.service')));
    assert.ok(existsSync(path.join(home, '.local/share/starpi-companion/companion.db')), 'data stay without --purge');
  });

  it('refuse a bundle that does not verify, and a purge without --yes', () => {
    const bundle = unpack('linux-tampered');
    appendFileSync(path.join(bundle, 'app/src/service.js'), '\n');
    const home = path.join(scratch, 'home-tampered');
    mkdirSync(home);
    const out = run('sh', [path.join(bundle, 'deploy/linux/install.sh'), '--no-systemctl'], { env: homeEnv(home) });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /does not match its checksum[\s\S]*NOT installed/);
    assert.ok(!existsSync(path.join(home, '.local')));
    const purge = run('sh', [path.join(bundle, 'deploy/linux/uninstall.sh'), '--purge'], { env: homeEnv(home) });
    assert.equal(purge.status, 1);
    assert.match(purge.stderr, /--purge --yes/);
  });

  it('install the system variant below a root folder: accounts, configuration, splice unit, key drop-in', () => {
    const bundle = unpack('linux-system');
    const root = path.join(scratch, 'sysroot');
    const out = run('sh', [path.join(bundle, 'deploy/linux/install.sh'), '--system', '--root', root, '--kek', 'systemd-creds'], { env: homeEnv(path.join(scratch, 'nohome')) });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    const unitDir = path.join(root, 'etc/systemd/system');
    const companion = readFileSync(path.join(unitDir, 'starpi-companion.service'), 'utf8');
    const splice = readFileSync(path.join(unitDir, 'starpi-companion-egress.service'), 'utf8');
    for (const line of ['Type=notify', 'NotifyAccess=all', 'User=starpi-companion', 'SupplementaryGroups=starpi-egress-client', 'IPAddressDeny=any', 'IPAddressAllow=localhost']) {
      assert.match(companion, new RegExp(`^${line}$`, 'm'), line);
    }
    assert.match(companion, /^Environment=.*\bSTARPI_COMPANION_EGRESS_SOCKET=\/run\/starpi-companion-egress\/splice\.sock\b/m);
    assert.match(splice, /^ExecStart=\S+ \/opt\/starpi-companion\/current\/bin\/starpi-companion\.mjs egress-splice --socket \/run\/starpi-companion-egress\/splice\.sock --config %d\/companion-config$/m);
    assert.match(splice, /^Group=starpi-egress-client$/m);
    assert.match(readFileSync(path.join(unitDir, 'starpi-companion.service.d/kek.conf'), 'utf8'), /^LoadCredentialEncrypted=starpi-companion-kek:\/etc\/credstore\.encrypted\/starpi-companion-kek$/m);
    const config = JSON.parse(readFileSync(path.join(root, 'etc/starpi-companion/config.json'), 'utf8'));
    assert.deepEqual(config.vault.kek, { provider: 'systemd-creds', credential: '/etc/credstore.encrypted/starpi-companion-kek', user: false });
    assert.equal(config.dataDir, '/var/lib/starpi-companion');
    assert.match(readFileSync(path.join(root, 'usr/local/bin/starpi-companion'), 'utf8'), /runuser -u starpi-companion --/);
    if (existsSync(path.join(root, 'etc/group'))) {
      const group = readFileSync(path.join(root, 'etc/group'), 'utf8');
      assert.match(group, /^starpi-egress-client:x:\d+:$/m, 'the client group has no members');
      assert.match(readFileSync(path.join(root, 'etc/passwd'), 'utf8'), /^starpi-companion:x:\d+:\d+:/m);
    }
    const removed = run('sh', [path.join(root, 'opt/starpi-companion/deploy/uninstall.sh'), '--root', root, '--purge', '--yes'], { env: homeEnv(path.join(scratch, 'nohome')) });
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!existsSync(path.join(unitDir, 'starpi-companion.service')) && !existsSync(path.join(root, 'etc/starpi-companion')) && !existsSync(path.join(root, 'opt/starpi-companion')));
  });

  it('render units that systemd-analyze accepts', { skip: !has('systemd-analyze') && 'systemd-analyze is not installed' }, () => {
    const units = path.join(scratch, 'units');
    const runtime = path.join(scratch, 'runtime');
    mkdirSync(units);
    mkdirSync(runtime, { mode: 0o700 });
    const app = path.join(packed.dir, 'app');
    const deploy = path.join(ROOT, 'packages/companion/deploy/linux');
    const render = (/** @type {string} */ from, /** @type {string} */ to) => {
      const text = readFileSync(path.join(deploy, from), 'utf8').replaceAll('@NODE@', process.execPath).replaceAll('@APP@', app).replaceAll('@CREDENTIAL@', '/etc/credstore.encrypted/starpi-companion-kek');
      writeFileSync(path.join(units, to), text);
      return path.join(units, to);
    };
    const quiet = (/** @type {string} */ stderr) => stderr.split('\n').filter((l) => l && !/Failed to connect to (system|user) bus|Failed to lookup RuntimeDirectory|No such file or directory$/.test(l));
    const user = run('systemd-analyze', ['verify', '--user', '--man=no', render('user/starpi-companion.service', 'starpi-companion.service')], { env: { ...process.env, XDG_RUNTIME_DIR: runtime } });
    assert.equal(user.status, 0, user.stderr);
    assert.deepEqual(quiet(user.stderr), []);
    const system = run('systemd-analyze', ['verify', '--man=no', render('system/starpi-companion.service', 'starpi-companion-system.service'), render('system/starpi-companion-egress.service', 'starpi-companion-egress.service')]);
    assert.equal(system.status, 0, system.stderr);
    assert.deepEqual(quiet(system.stderr), []);
  });
});

describe('the macOS install scripts', () => {
  it('write a valid launchd agent, sandboxed on request, and remove it again', () => {
    const bundle = unpack('macos');
    const home = path.join(scratch, 'home-mac');
    mkdirSync(home);
    const env = homeEnv(home);
    const out = run('sh', [path.join(bundle, 'deploy/macos/install.sh'), '--no-launchctl', '--sandbox', '--key', PUBLIC_FILE], { env });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    const plist = path.join(home, 'Library/LaunchAgents/app.starpi.companion.plist');
    const text = readFileSync(plist, 'utf8');
    assert.doesNotMatch(text, /@[A-Z_]+@/);
    assert.match(text, /<string>\/usr\/bin\/sandbox-exec<\/string>/);
    assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    if (has('python3')) {
      // The script comes on stdin, so no argument list here carries a -c.
      const parsed = run('python3', ['-I', '-', plist], { input: 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))' });
      assert.equal(parsed.status, 0, parsed.stderr);
      const agent = JSON.parse(parsed.stdout);
      assert.equal(agent.Label, 'app.starpi.companion');
      assert.deepEqual(agent.ProgramArguments.slice(-2), [path.join(home, '.local/opt/starpi-companion/current/bin/starpi-companion.mjs'), 'start']);
      assert.ok(agent.ProgramArguments.includes(`SUPPORT=${home}/Library/Application Support/starpi-companion`));
    }
    const removed = run('sh', [path.join(home, '.local/opt/starpi-companion/deploy/uninstall.sh'), '--no-launchctl'], { env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!existsSync(plist) && !existsSync(path.join(home, '.local/opt/starpi-companion')));
  });
});
