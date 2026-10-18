// @ts-check
// The service: opens the installation, checks it, and starts the kernel around it.
//
// Start order:
//  1. open the installation (KEK, keyring, store, vault, identity, chain); a new data folder
//     becomes a new installation;
//  2. check it: the audit chain and the event links recompute, and the anchor folder (pinned key,
//     anchors) is reached by the database; otherwise refuse with the finding's code
//     (`audit_tampered`, `audit_rollback`, `anchor_invalid`, `anchor_key_mismatch`,
//     `anchor_dir_missing`) and change nothing;
//  3. apply the deletion list, record the start in the chain;
//  4. install the egress guard and hand each module the capability for its configured hosts;
//  5. build brains, breaker, admission, scheduler, sessions and routes, start modules, listen;
//  6. write an anchor, tell systemd READY.
// Stop runs the reverse and writes a last anchor.
import { createAdmission } from './admission/admission.js';
import { createAnchorWriter, checkAnchors, pinKey, readPinnedKey } from './audit/anchors.js';
import { verifyChain } from './audit/chain.js';
import { createOriginPolicy } from './auth/origins.js';
import { createSessions } from './auth/sessions.js';
import { createBrainRouter } from './brain/router.js';
import { BRAINS_MODULE, buildBrains } from './brain/index.js';
import { createNoneBrain } from './brain/none.js';
import { createBreaker } from './breaker/breaker.js';
import { checkModule } from './contracts/module.js';
import { installEgressGuard, openCapability } from './egress/guard.js';
import { EGRESS_SOCKET_ENV, spliceTransport } from './egress/splice.js';
import { openInstallation } from './installation.js';
import { resolveTimeZone, systemClock } from './lib/clock.js';
import { fail } from './lib/errors.js';
import { silentLogger } from './lib/log.js';
import { createNotifier } from './platform/sd-notify.js';
import { createScheduler } from './scheduler/scheduler.js';
import { createHttpServer, createRouteTable } from './server/http.js';
import { kernelRoutes } from './server/routes.js';
import { createStaticSite } from './server/static.js';
import { verifyEventLinks } from './store/sqlite.js';
import { VERSION } from './version.js';

/**
 * Refuses to start when the installation does not verify.
 * @param {import('./installation.js').Installation} inst
 * @param {{ acceptNewAnchors?: boolean }} options
 */
export function checkBeforeStart(inst, { acceptNewAnchors = false } = {}) {
  const { db } = inst.store;
  const chain = verifyChain(db);
  if (chain.findings.length > 0) throw fail('audit_tampered', `the audit chain does not verify (${chain.findings[0].kind} at ${chain.findings[0].seq})`, { details: { findings: chain.findings } });
  const links = verifyEventLinks(db);
  if (links.length > 0) throw fail('audit_tampered', `the event log does not verify (${links[0].kind} at ${links[0].seq})`, { details: { findings: links } });
  const pinned = readPinnedKey(inst.config.anchorDir);
  if (!pinned) {
    if (!inst.fresh && chain.records > 0 && !acceptNewAnchors) {
      throw fail('anchor_dir_missing', `the anchor folder ${inst.config.anchorDir} holds no anchors for this installation; mount it, or start a new line of anchors on purpose (--accept-new-anchors)`);
    }
    pinKey(inst.config.anchorDir, inst.identity);
    return { newLine: !inst.fresh };
  }
  const result = checkAnchors({ db, anchorDir: inst.config.anchorDir, keyId: inst.identity.keyId });
  if (result.findings.length > 0) {
    const first = result.findings[0];
    const code = first.kind === 'audit_rollback' ? 'audit_rollback' : first.kind === 'anchor_key_mismatch' ? 'anchor_key_mismatch' : 'anchor_invalid';
    throw fail(code, `start refused: ${first.kind}${first.reason ? ` (${first.reason})` : ''}${first.detail ? `: ${first.detail}` : ''}`, { details: { findings: result.findings } });
  }
  return { newLine: false };
}

/**
 * Hands out egress capabilities: one per module, for the hosts configured for it.
 * @param {Record<string, string[]>} allow
 * @param {import('./egress/guard.js').EgressGuard | null} guard
 * @param {typeof fetch} [unguardedFetch]  only without a guard (tests): the fetch the capabilities wrap
 */
function capabilities(allow, guard, unguardedFetch = globalThis.fetch) {
  /** @type {Map<string, import('./egress/guard.js').EgressCapability>} */
  const out = new Map();
  for (const [moduleId, entries] of Object.entries(allow)) {
    if (entries.length === 0) continue;
    out.set(moduleId, guard ? guard.capability(entries) : openCapability(entries, unguardedFetch));
  }
  return out;
}

/**
 * Starts the companion.
 * @param {object} options
 * @param {import('./config.js').CompanionConfig} options.config
 * @param {import('./contracts/module.js').CompanionModule[]} [options.modules]
 * @param {boolean} [options.guard]              install the egress guard (the CLI does; tests may not)
 * @param {boolean} [options.acceptNewAnchors]
 * @param {import('./lib/clock.js').Clock} [options.clock]
 * @param {import('./lib/log.js').Logger} [options.log]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {import('./vault/kek/runner.js').ProgramRunner} [options.run]
 * @param {() => Promise<any>} [options.loadSdk]
 * @param {typeof fetch} [options.unguardedFetch]
 */
export async function startCompanion({ config, modules = [], guard = false, acceptNewAnchors = false, clock = systemClock, log = silentLogger, env = process.env, run, loadSdk, unguardedFetch }) {
  for (const mod of modules) {
    const problems = checkModule(mod);
    if (problems.length > 0) throw fail('module_invalid', `module refused: ${problems.join('; ')}`);
  }
  if (new Set(modules.map((m) => m.id)).size !== modules.length) throw fail('module_invalid', 'two modules share an id');
  if (modules.some((m) => m.id === BRAINS_MODULE)) throw fail('module_invalid', `${BRAINS_MODULE} is the kernel's own egress name`);

  const inst = await openInstallation({ config, create: true, modules, clock, run, env });
  /** @type {import('./egress/guard.js').EgressGuard | null} */
  let egress = null;
  /** @type {Array<() => Promise<void> | void>} */
  const undo = [() => inst.close()];
  const rollbackStart = async () => {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch {
        // best effort while refusing to start
      }
    }
  };
  try {
    const { newLine } = checkBeforeStart(inst, { acceptNewAnchors });
    const reconciled = inst.vault.reconcile();
    const startedAt = clock.now();
    const timeZone = resolveTimeZone(config.timeZone);
    inst.chain.append({ kind: 'companion.started', subject: VERSION, details: { profile: config.profile, fresh: inst.fresh, newAnchorLine: newLine, modules: modules.map((m) => m.id) } });
    if (reconciled.namespaces + reconciled.items > 0) inst.chain.append({ kind: 'vault.reconciled', subject: 'deletions', details: reconciled });

    if (guard) {
      const socketPath = env[EGRESS_SOCKET_ENV];
      egress = installEgressGuard({
        transport: socketPath ? spliceTransport({ socketPath }) : undefined,
        onBlocked: (report) => log('warn', 'egress_blocked', { api: report.api, target: report.target }),
      });
      undo.push(() => egress?.uninstall());
    }
    const caps = capabilities(config.egress.allow, egress, unguardedFetch);

    const secrets = inst.vault.namespace('secrets');
    const brains = buildBrains({ config: config.brains, secret: (name) => secrets.getText(name), capability: caps.get(BRAINS_MODULE) ?? null, loadSdk });
    const breaker = createBreaker({
      clock,
      onChange: (change) => {
        log(change.to === 'steady' ? 'info' : 'warn', 'breaker_changed', change);
        inst.chain.append({ kind: change.actor === 'companion' ? 'breaker.raised' : 'breaker.reset', subject: change.to, actor: change.actor, details: { from: change.from, reason: change.reason } });
        if (change.to === 'steady') scheduler.resume(['events', 'background']);
        else scheduler.pause(change.to === 'slowed' ? ['background'] : ['events', 'background']);
      },
    });
    const scheduler = createScheduler({ concurrency: config.scheduler.concurrency, interactiveReserve: config.scheduler.interactiveReserve, clock, onError: (err, lane, name) => log('warn', 'job_failed', { lane, job: name, error: err }) });
    undo.push(() => scheduler.stop());
    const admission = createAdmission({ budgetMb: config.admission.budgetMb, reserveMb: config.admission.reserveMb, clock });
    const none = createNoneBrain();
    const router = createBrainRouter({ brains, none, policy: { personalToCloud: config.router.personalToCloud }, breaker, admission, clock });
    const sessions = createSessions({ store: inst.store, chain: inst.chain, clock, sessionDays: config.sessions.days });

    /** @type {ReturnType<typeof createHttpServer> | null} */
    let http = null;
    const origins = createOriginPolicy({ allowed: config.allowedOrigins, port: () => http?.port() ?? config.port });
    const routes = createRouteTable();
    const anchors = createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity, clock, every: config.audit.anchorEvery, intervalMs: config.audit.anchorIntervalS * 1000, log });

    const status = () => {
      const anchorState = checkAnchors({ db: inst.store.db, anchorDir: config.anchorDir, keyId: inst.identity.keyId });
      return {
        name: 'starpi-companion',
        version: VERSION,
        profile: config.profile,
        startedAt: new Date(startedAt).toISOString(),
        uptimeS: Math.round((clock.now() - startedAt) / 1000),
        timeZone,
        identity: { keyId: inst.identity.keyId, publicKey: inst.identity.publicKey },
        egress: { guarded: egress !== null, allow: Object.fromEntries([...caps].map(([id, cap]) => [id, [...cap.targets]])), spawning: 'forbidden' },
        brains: router.describe(),
        breaker: breaker.stats(),
        scheduler: scheduler.stats(),
        admission: admission.stats(),
        vault: { namespaces: inst.vault.stats(), kek: inst.kekProvider.describe() },
        audit: { head: inst.chain.signedHead(), anchors: { count: anchorState.anchors.length, newest: anchorState.newest?.n ?? null, findings: anchorState.findings.length } },
        sessions: sessions.list().length,
        modules: modules.map((m) => ({ id: m.id, version: m.version })),
      };
    };

    for (const route of kernelRoutes({ version: VERSION, installation: inst, sessions, origins, status, breaker, cookieName: () => http?.cookieName() ?? `starpi_companion_${config.port}`, sessionDays: config.sessions.days })) routes.add(route);

    // Modules get the kernel narrowed to what they declared.
    for (const mod of modules) {
      const prefix = `${mod.id.replace(/-/g, '_')}.`;
      const declared = new Set(mod.namespaces ?? []);
      const granted = (mod.egress ?? []).filter((entry) => caps.get(mod.id)?.targets.includes(entry));
      for (const route of mod.routes ?? []) routes.add({ ...route, path: `/v1/${mod.id}${route.path === '/' ? '' : route.path}` });
      await mod.start?.({
        id: mod.id,
        config: config.modules[mod.id] ?? {},
        clock,
        timeZone,
        log: (/** @type {any} */ level, /** @type {string} */ event, /** @type {any} */ fields = {}) => log(level, `${mod.id}.${event}`, fields),
        events: { append: inst.store.append, read: inst.store.read },
        db: inst.store.db,
        vault: {
          /** @param {string} ns */
          namespace(ns) {
            if (!declared.has(ns)) throw fail('module_namespace', `${mod.id} did not declare the namespace ${ns}`);
            return inst.vault.namespace(ns);
          },
        },
        audit: {
          /** @param {{ kind: string, subject?: string, actor?: string, details?: Record<string, unknown> }} entry */
          append(entry) {
            if (!entry.kind.startsWith(prefix)) throw fail('module_audit_kind', `${mod.id} writes audit kinds starting with ${prefix}`);
            return inst.chain.append(entry);
          },
          signedHead: () => inst.chain.signedHead(),
        },
        brains: router,
        scheduler,
        egress: granted.length > 0 ? /** @type {import('./egress/guard.js').EgressCapability} */ (caps.get(mod.id)).narrow(granted) : null,
        identity: { keyId: inst.identity.keyId, publicKey: inst.identity.publicKey },
      });
      undo.push(async () => {
        await mod.stop?.();
      });
    }

    const site = config.appDir ? createStaticSite({ dir: config.appDir }) : null;
    http = createHttpServer({ host: config.host, port: config.port, routes, origins, sessions, auditHead: () => inst.chain.signedHead(), site, breaker, log });
    const port = await http.listen();
    undo.push(() => http?.close());
    anchors.start();

    scheduler.every('sessions.sweep', 3_600_000, () => sessions.sweep());
    scheduler.every('breaker.memory', 15_000, () => breaker.observe({ rssMb: process.memoryUsage().rss / 1_048_576 }), 'events');
    const notifier = createNotifier({ env, clock, run, healthy: () => breaker.level() !== 'halted' });
    await notifier.ready(`listening on 127.0.0.1:${port}`);
    log('info', 'companion_started', { port, version: VERSION, profile: config.profile, guarded: egress !== null });

    let stopped = false;
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      installation: inst,
      router,
      breaker,
      scheduler,
      sessions,
      routes,
      egress,
      status,
      anchors,
      async stop() {
        if (stopped) return;
        stopped = true;
        await notifier.stopping();
        scheduler.stop();
        await http?.close();
        for (const mod of [...modules].reverse()) {
          try {
            await mod.stop?.();
          } catch (err) {
            log('warn', 'module_stop_failed', { module: mod.id, error: err });
          }
        }
        inst.chain.append({ kind: 'companion.stopped', subject: VERSION, details: { uptimeS: Math.round((clock.now() - startedAt) / 1000) } });
        anchors.stop();
        inst.close();
        egress?.uninstall();
        log('info', 'companion_stopped', {});
      },
    };
  } catch (err) {
    await rollbackStart();
    throw err;
  }
}

/** @typedef {Awaited<ReturnType<typeof startCompanion>>} Companion */
