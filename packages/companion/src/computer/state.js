// @ts-check
// What the computer control keeps across restarts, sealed in its vault namespace as one item: the
// consent (who granted it, when, which statement), the stop flag (set by a stop, cleared only when
// the owner starts a new mandate) and the record of the latest mandate. The record holds ids, times
// and counts only; the task text, previews, screen reports and model text stay in memory and are
// dropped with the mandate.

const ITEM = 'control';

/**
 * @typedef {object} ConsentRecord
 * @property {string} at
 * @property {string} by          the session that granted it
 * @property {number} version     of the consent statement
 * @property {string} statement   SHA-256 of the statement
 */

/**
 * @typedef {object} MandateRecord
 * @property {string} id
 * @property {string} owner       the session that started it
 * @property {'active' | 'ended'} state
 * @property {string} startedAt
 * @property {string} expiresAt
 * @property {number} extensions
 * @property {string[]} actions
 * @property {boolean} shareable
 * @property {string} taskDigest  SHA-256 of the task text (the text itself is never stored)
 * @property {import('./limits.js').EndReason | null} endReason
 * @property {string | null} endedAt
 */

/**
 * @typedef {object} ControlRecord
 * @property {ConsentRecord | null} consent
 * @property {{ at: string, by: string } | null} halt
 * @property {MandateRecord | null} mandate
 */

/**
 * @param {{ getJson: (id: string) => any, putJson: (id: string, value: unknown) => void }} space  the module's vault namespace
 */
export function openComputerState(space) {
  /** @returns {ControlRecord} */
  const read = () => {
    const stored = space.getJson(ITEM);
    return {
      consent: stored?.consent ?? null,
      halt: stored?.halt ?? null,
      mandate: stored?.mandate ?? null,
    };
  };
  /** @param {Partial<ControlRecord>} change */
  const write = (change) => space.putJson(ITEM, { ...read(), ...change });

  return Object.freeze({
    read,
    /** @param {ConsentRecord | null} consent */
    setConsent: (consent) => write({ consent }),
    /** @param {{ at: string, by: string } | null} halt */
    setHalt: (halt) => write({ halt }),
    /** @param {MandateRecord | null} mandate */
    setMandate: (mandate) => write({ mandate }),
  });
}

/** @typedef {ReturnType<typeof openComputerState>} ComputerState */
