// @ts-check
// `starpi-companion verify-audit`: recomputes the audit chain and the event links and checks the
// anchors. Exit code 0 when everything verifies, 1 with the findings.
import { openInstallation } from '../../installation.js';
import { verifyInstallation } from '../../audit/verify.js';

/** @type {import('../context.js').Command} */
export const verifyAuditCommand = {
  name: 'verify-audit',
  summary: 'verify the audit chain, the event log and the anchors',
  usage: 'verify-audit [--json]',
  async run(ctx) {
    const config = ctx.config();
    const inst = await openInstallation({ config, env: ctx.env });
    try {
      const report = verifyInstallation({ db: inst.store.db, anchorDir: config.anchorDir, keyId: inst.identity.keyId });
      if (ctx.flags.json) ctx.json(report);
      else {
        ctx.out(`audit chain   ${report.records} records, head ${report.head.seq} ${report.head.hash.slice(0, 16)}`);
        ctx.out(`event log     ${report.events.seq} events`);
        ctx.out(`anchors       ${report.anchors.count}${report.anchors.newest ? `, newest ${report.anchors.newest}` : ''}`);
        if (report.ok) ctx.out('OK: everything verifies');
        else for (const f of report.findings) ctx.out(`FINDING ${f.kind}${f.seq !== undefined ? ` at ${f.seq}` : ''}${f.n !== undefined ? ` (anchor ${f.n})` : ''}${f.reason ? ` ${f.reason}` : ''}${f.detail ? `: ${f.detail}` : ''}`);
      }
      return report.ok ? 0 : 1;
    } finally {
      inst.close();
    }
  },
};
