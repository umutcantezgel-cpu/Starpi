// @ts-check
// Approvals of single tool calls: a call that its tool's policy, or an earlier tool result in the
// same turn, makes wait for a person. The waiting call shows up in the list (with a short preview
// of its arguments) and in the chat's stream; a person approves or denies it, or it expires. A tool
// result can never decide an approval: only a request of a paired session can.
import { randomUUID } from 'node:crypto';
import { isoAt } from '../lib/clock.js';
import { clip } from '../setup/kit.js';

/** @typedef {'approved' | 'denied' | 'expired' | 'cancelled'} Outcome */

/**
 * @param {{ clock: import('../lib/clock.js').Clock, timeoutMs: number, onPending?: (a: { id: string, server: string, tool: string }) => void }} options
 */
export function createApprovals({ clock, timeoutMs, onPending = () => {} }) {
  /** @type {Map<string, { id: string, server: string, tool: string, preview: string, reason: string, asked: string, expires: string, by: string | null, settle: (o: Outcome) => void, timer: unknown }>} */
  const pending = new Map();

  return {
    /**
     * Waits for a decision about a call.
     * @param {{ server: string, tool: string, args: Record<string, unknown>, reason: 'policy' | 'after_result' }} call
     * @param {{ signal?: AbortSignal, onAsk?: (a: { id: string, server: string, tool: string, expires: string, reason: string }) => void }} [options]
     * @returns {Promise<{ id: string, outcome: Outcome, by: string | null }>}
     */
    ask(call, { signal, onAsk } = {}) {
      const id = randomUUID();
      const asked = clock.now();
      return new Promise((resolve) => {
        /** @param {Outcome} outcome */
        const settle = (outcome) => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clock.clearTimeout(entry.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve({ id, outcome, by: entry.by });
        };
        const onAbort = () => settle('cancelled');
        const timer = clock.setTimeout(() => settle('expired'), timeoutMs);
        const entry = {
          id,
          server: call.server,
          tool: call.tool,
          preview: clip(JSON.stringify(call.args), 300),
          reason: call.reason,
          asked: isoAt(asked),
          expires: isoAt(asked + timeoutMs),
          by: /** @type {string | null} */ (null),
          settle,
          timer,
        };
        pending.set(id, entry);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          settle('cancelled');
          return;
        }
        onAsk?.({ id, server: call.server, tool: call.tool, expires: entry.expires, reason: call.reason });
        onPending({ id, server: call.server, tool: call.tool });
      });
    },
    /**
     * A person's decision.
     * @param {string} id
     * @param {'approve' | 'deny'} decision
     * @param {string} actor
     * @returns {boolean} whether a waiting call had that id
     */
    decide(id, decision, actor) {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.by = actor;
      entry.settle(decision === 'approve' ? 'approved' : 'denied');
      return true;
    },
    list: () => [...pending.values()].map(({ id, server, tool, preview, reason, asked, expires }) => ({ id, server, tool, preview, reason, asked, expires })),
    cancelAll() {
      for (const entry of [...pending.values()]) entry.settle('cancelled');
    },
  };
}

/** @typedef {ReturnType<typeof createApprovals>} Approvals */
