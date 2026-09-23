import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/locales');

const en = JSON.parse(readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(LOCALES_DIR, 'de.json'), 'utf8'));

/**
 * Recursively extracts all dotted key paths from an object.
 * @param {Record<string, any>} obj
 * @param {string} prefix
 * @returns {string[]}
 */
function getDottedKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...getDottedKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

describe('i18n key parity and resolution', () => {
  const enKeys = getDottedKeys(en);
  const deKeys = getDottedKeys(de);

  it('has identical 1:1 key schemas in en.json and de.json', () => {
    const missingInDe = enKeys.filter((k) => !deKeys.includes(k));
    const missingInEn = deKeys.filter((k) => !enKeys.includes(k));

    assert.deepEqual(missingInDe, [], `Keys present in en.json but missing in de.json: ${missingInDe.join(', ')}`);
    assert.deepEqual(missingInEn, [], `Keys present in de.json but missing in en.json: ${missingInEn.join(', ')}`);
  });

  it('contains no empty translation values in any dictionary', () => {
    /** @param {Record<string, any>} dict */
    function checkNonEmpty(dict, p = '') {
      for (const [k, v] of Object.entries(dict)) {
        const full = p ? `${p}.${k}` : k;
        if (typeof v === 'string') {
          assert.ok(v.trim().length > 0, `Empty string at ${full}`);
        } else if (v && typeof v === 'object') {
          checkNonEmpty(v, full);
        }
      }
    }
    checkNonEmpty(en);
    checkNonEmpty(de);
  });
});
