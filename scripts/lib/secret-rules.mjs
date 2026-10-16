// The custom rules of .gitleaks.toml as JavaScript RegExps. The file is the one list of key and
// token formats: gitleaks scans the repository with it in CI, scripts/verify-dist.mjs and
// scripts/sbom.mjs refuse output that matches a key or token rule, and the unit tests check every
// rule against keys assembled at run time.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ id: string, description: string, keywords: string[], re: RegExp }} SecretRule
 */

/**
 * Parses the [[rules]] tables of a gitleaks config. Only the shape this repository writes is read:
 * one `key = value` per line, the regex as a TOML literal string ('''...''', no escapes).
 * @param {string} toml
 * @returns {SecretRule[]}
 */
export function parseGitleaksRules(toml) {
  return toml
    .split(/^(?=\[)/m)
    .filter((table) => table.startsWith('[[rules]]'))
    .map((table) => {
      const id = /^id = "([^"]+)"$/m.exec(table)?.[1];
      const source = /^regex = '''(.+)'''$/m.exec(table)?.[1];
      if (!id || !source) throw new Error(`.gitleaks.toml: a rule without id or regex:\n${table}`);
      const keywords = [.../^keywords = \[(.*)\]$/m.exec(table)?.[1].matchAll(/"([^"]*)"/g) ?? []].map((m) => m[1]);
      return { id, description: /^description = "([^"]*)"$/m.exec(table)?.[1] ?? '', keywords, re: new RegExp(source) };
    });
}

/**
 * The rules of the repository's .gitleaks.toml.
 * @param {string} root
 */
export function readGitleaksRules(root) {
  return parseGitleaksRules(readFileSync(path.join(root, '.gitleaks.toml'), 'utf8'));
}

/**
 * The rules for credentials (ids ending in -key or -token), which must never reach shipped output.
 * @param {string} root
 */
export function credentialRules(root) {
  return readGitleaksRules(root).filter((rule) => /-(?:key|token)$/.test(rule.id));
}
