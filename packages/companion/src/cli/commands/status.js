// @ts-check
// `starpi-companion status`: the installation as seen from its files (version, folders, audit
// head, anchors, vault namespaces, paired devices) and whether a companion answers on the port.
import { openInstallation } from '../../installation.js';
import { checkAnchors } from '../../audit/anchors.js';
import { VERSION } from '../../version.js';

/** @param {number} port */
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/hello`, { signal: AbortSignal.timeout(1500) });
    const body = /** @type {any} */ (await res.json());
    return res.ok && body?.name === 'starpi-companion' ? { running: true, version: body.version } : { running: false, version: null };
  } catch {
    return { running: false, version: null };
  }
}

/** @type {import('../context.js').Command} */
export const statusCommand = {
  name: 'status',
  summary: 'show the installation and whether the companion runs',
  usage: 'status [--json]',
  async run(ctx) {
    const config = ctx.config();
    const inst = await openInstallation({ config, env: ctx.env });
    try {
      const anchors = checkAnchors({ db: inst.store.db, anchorDir: config.anchorDir, keyId: inst.identity.keyId });
      const live = await probe(config.port);
      const report = {
        version: VERSION,
        running: live.running,
        runningVersion: live.version,
        url: `http://127.0.0.1:${config.port}`,
        profile: config.profile,
        dataDir: config.dataDir,
        anchorDir: config.anchorDir,
        identity: inst.identity.keyId,
        kek: inst.kekProvider.describe(),
        audit: inst.chain.head(),
        anchors: { count: anchors.anchors.length, newest: anchors.newest?.n ?? null, ok: anchors.findings.length === 0 },
        namespaces: inst.vault.stats(),
        sessions: inst.store.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked = 0 AND expires > ?').get(Date.now()),
        egress: config.egress.allow,
      };
      if (ctx.flags.json) ctx.json(report);
      else {
        ctx.out(`Starpi Core (local companion) ${VERSION}: ${live.running ? `running on ${report.url}` : 'not running'}`);
        ctx.out(`profile      ${report.profile}`);
        ctx.out(`data         ${report.dataDir}`);
        ctx.out(`anchors      ${report.anchorDir} (${report.anchors.count}, ${report.anchors.ok ? 'verified' : 'NOT VERIFIED'})`);
        ctx.out(`identity     ${report.identity}`);
        ctx.out(`kek          ${report.kek}`);
        ctx.out(`audit head   ${report.audit.seq} ${report.audit.hash.slice(0, 16)}`);
        ctx.out(`namespaces   ${Object.entries(report.namespaces).map(([n, c]) => `${n}:${c}`).join(' ') || '(none)'}`);
        const egress = Object.entries(report.egress).map(([m, list]) => `${m}=${list.join(',')}`).join(' ');
        ctx.out(`egress       ${egress || 'none (zero egress)'}`);
      }
      return anchors.findings.length === 0 ? 0 : 1;
    } finally {
      inst.close();
    }
  },
};

