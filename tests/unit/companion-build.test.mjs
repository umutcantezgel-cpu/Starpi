// The build of the profile `companion` (scripts/build.mjs): the header rules it writes next to the
// build are ones the companion's static server takes (it sets media types itself and refuses a
// build that sets one), and STARPI_DIST_DIR never points the build, which empties its folder first,
// at the checkout or a source folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_PROFILES, headersDigest, resolveHeaderRules } from '../../scripts/lib/headers.mjs';
import { loadHeaderRules } from '../../packages/companion/src/server/static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('companion build', () => {
  it('writes header rules the companion accepts', () => {
    for (const profile of CORE_PROFILES) {
      const dir = mkdtempSync(path.join(tmpdir(), 'starpi-headers-'));
      try {
        const rules = resolveHeaderRules(profile);
        writeFileSync(path.join(dir, 'headers.json'), JSON.stringify({ profile, digest: headersDigest(rules), rules }));
        const loaded = loadHeaderRules(dir);
        assert.ok(loaded.length > 0, profile);
        assert.ok(rules.every((r) => r.headers.every((h) => h.key.toLowerCase() !== 'content-type')), `${profile} sets no media type`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('refuses a build folder that would empty the checkout or a source folder', () => {
    for (const target of ['.', '..', 'src', 'src/js/out', 'packages/companion']) {
      const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, env: { ...process.env, STARPI_DIST_DIR: target }, encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.status, 1, target);
      assert.match(run.stderr, /STARPI_DIST_DIR/, target);
    }
  });
});
