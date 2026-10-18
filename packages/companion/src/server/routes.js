// @ts-check
// The kernel's own HTTP routes. Modules add theirs below /v1/<module id>/.
//   GET    /v1/hello               public   { name, version, pairing: true } (the app's probe)
//   POST   /v1/session/pair        public   a pairing code becomes a cookie (same origin) or a bearer token (allowed origin)
//   GET    /v1/session             member   the current session
//   POST   /v1/session/logout      member   ends the current session
//   GET    /v1/status              member   version, profile, egress list, brains, breaker, vault counts, audit head
//   GET    /v1/audit/head          member   the signed head now, or of an earlier record (?seq=)
//   GET    /v1/audit/verify        owner    verifies chain, event links and anchors
//   GET    /v1/sessions            owner    paired devices;  DELETE /v1/sessions/:id  revokes one
//   GET    /v1/secrets             owner    secret names;    PUT/DELETE /v1/secrets/:name
//   POST   /v1/vault/erase         owner    crypto-erases a namespace
//   POST   /v1/breaker/reset       owner    steps the breaker back to steady
import { fail } from '../lib/errors.js';
import { NAME } from '../contracts/check.js';
import { NAMESPACE } from '../contracts/module.js';
import { verifyInstallation } from '../audit/verify.js';

/**
 * @param {object} ctx
 * @param {string} ctx.version
 * @param {import('../installation.js').Installation} ctx.installation
 * @param {import('../auth/sessions.js').Sessions} ctx.sessions
 * @param {import('../auth/origins.js').OriginPolicy} ctx.origins
 * @param {() => Record<string, unknown>} ctx.status
 * @param {import('../breaker/breaker.js').Breaker} ctx.breaker
 * @param {() => string} ctx.cookieName
 * @param {number} ctx.sessionDays
 * @returns {import('./http.js').Route[]}
 */
export function kernelRoutes({ version, installation, sessions, origins, status, breaker, cookieName, sessionDays }) {
  const { chain, identity, vault, store } = installation;
  const secrets = vault.namespace('secrets');
  /** @param {import('./http.js').RouteRequest} req */
  const actor = (req) => (req.session ? `session:${req.session.id.slice(0, 8)}` : 'anonymous');

  return [
    {
      method: 'GET',
      path: '/v1/hello',
      access: 'public',
      lane: 'status',
      handler: () => ({ body: { name: 'starpi-companion', version, pairing: true } }),
    },
    {
      method: 'POST',
      path: '/v1/session/pair',
      access: 'public',
      lane: 'status',
      maxBody: 4096,
      handler(req) {
        const kind = req.sameOrigin ? 'cookie' : origins.isAllowed(req.origin) ? 'bearer' : null;
        if (kind === null) throw fail('origin_not_allowed', 'pair from the companion itself or an allowed origin', { status: 403 });
        const result = sessions.pair({ code: req.body?.code, kind, origin: kind === 'bearer' ? req.origin : null, label: req.body?.label });
        const body = { mode: kind, session: result.session, role: result.role, expiresAt: result.expiresAt, publicKey: identity.publicKey, keyId: identity.keyId };
        if (kind === 'cookie') {
          return { body: { ...body, csrf: result.csrf }, cookies: [{ name: cookieName(), value: result.token, maxAge: sessionDays * 86_400 }] };
        }
        return { body: { ...body, token: result.token } };
      },
    },
    {
      method: 'GET',
      path: '/v1/session',
      access: 'member',
      lane: 'status',
      handler: (req) => {
        const s = /** @type {import('../auth/sessions.js').Session} */ (req.session);
        return { body: { session: s.id, kind: s.kind, role: s.role, label: s.label, origin: s.origin, expiresAt: new Date(s.expires).toISOString() } };
      },
    },
    {
      method: 'POST',
      path: '/v1/session/logout',
      access: 'member',
      lane: 'status',
      handler(req) {
        const s = /** @type {import('../auth/sessions.js').Session} */ (req.session);
        sessions.revoke({ id: s.id, actor: actor(req) });
        return { body: { ended: true }, cookies: s.kind === 'cookie' ? [{ name: cookieName(), value: '', maxAge: 0 }] : [] };
      },
    },
    {
      method: 'GET',
      path: '/v1/status',
      access: 'member',
      lane: 'status',
      handler: () => ({ body: status() }),
    },
    {
      method: 'GET',
      path: '/v1/audit/head',
      access: 'member',
      lane: 'status',
      handler(req) {
        const raw = req.query.get('seq');
        if (raw === null) return { body: { head: chain.signedHead(), keyId: identity.keyId, publicKey: identity.publicKey } };
        const seq = Number(raw);
        if (!Number.isInteger(seq) || seq < 1) throw fail('audit_seq_invalid', 'seq is a positive whole number', { status: 400 });
        const head = chain.signedHeadAt(seq);
        if (!head) throw fail('audit_seq_unknown', `the chain has no record ${seq}`, { status: 404 });
        return { body: { head, keyId: identity.keyId, publicKey: identity.publicKey } };
      },
    },
    {
      method: 'GET',
      path: '/v1/audit/verify',
      access: 'owner',
      handler: () => ({ body: { report: verifyInstallation({ db: store.db, anchorDir: installation.config.anchorDir, keyId: identity.keyId }) } }),
    },
    {
      method: 'GET',
      path: '/v1/sessions',
      access: 'owner',
      handler: () => ({ body: { sessions: sessions.list() } }),
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:id',
      access: 'owner',
      handler(req) {
        const n = sessions.revoke({ id: req.params.id, actor: actor(req) });
        if (n === 0) throw fail('session_unknown', 'no such active session', { status: 404 });
        return { body: { revoked: n } };
      },
    },
    {
      method: 'GET',
      path: '/v1/secrets',
      access: 'owner',
      handler: () => ({ body: { secrets: secrets.list().map((s) => ({ name: s.id, updated: s.updated })) } }),
    },
    {
      method: 'PUT',
      path: '/v1/secrets/:name',
      access: 'owner',
      maxBody: 16 * 1024,
      handler(req) {
        const name = req.params.name;
        if (!NAME.test(name)) throw fail('secret_name', 'a secret name is lower case, 2 to 64 characters', { status: 400 });
        const value = req.body?.value;
        if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw fail('secret_value', 'a secret value is a string of 1 to 8192 characters', { status: 400 });
        secrets.put(name, value);
        chain.append({ kind: 'secret.set', subject: name, actor: actor(req) });
        return { body: { name, stored: true } };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/secrets/:name',
      access: 'owner',
      handler(req) {
        const name = req.params.name;
        if (!NAME.test(name)) throw fail('secret_name', 'a secret name is lower case, 2 to 64 characters', { status: 400 });
        const removed = secrets.delete(name);
        if (!removed) throw fail('secret_unknown', 'no such secret', { status: 404 });
        chain.append({ kind: 'secret.removed', subject: name, actor: actor(req) });
        return { body: { name, removed: true } };
      },
    },
    {
      method: 'POST',
      path: '/v1/vault/erase',
      access: 'owner',
      maxBody: 1024,
      handler(req) {
        const ns = req.body?.namespace;
        if (typeof ns !== 'string' || !NAMESPACE.test(ns)) throw fail('vault_namespace', 'name the namespace to erase', { status: 400 });
        if (req.body?.confirm !== ns) throw fail('erase_unconfirmed', 'confirm the erase by repeating the namespace name', { status: 400 });
        const result = vault.erase(ns);
        chain.append({ kind: 'vault.erased', subject: ns, actor: actor(req), details: { items: result.items } });
        return { body: result };
      },
    },
    {
      method: 'POST',
      path: '/v1/breaker/reset',
      access: 'owner',
      lane: 'status',
      maxBody: 1024,
      handler(req) {
        breaker.reset({ actor: actor(req), reason: String(req.body?.reason ?? '') });
        return { body: { level: breaker.level() } };
      },
    },
  ];
}
