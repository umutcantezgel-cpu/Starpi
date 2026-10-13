// CycloneDX SBOMs from `npm sbom`, made deterministic and checked (scripts/sbom.mjs writes them).
// npm writes a random serial number and the current time into every document, names the root and
// workspace components after the directories they were checked out to, lists a package installed
// at two paths twice under one bom-ref, and describes a workspace inside the root project's tree.
// normalizeSbom and normalizeCoreSbom remove all of that, so a document depends only on
// package-lock.json, the package.json files, the timestamp passed in and the npm version.
import { createHash } from 'node:crypto';

export const SPEC_VERSION = '1.5';
export const SCHEMA_URL = 'http://cyclonedx.org/schema/bom-1.5.schema.json';
/** RFC 4122 name space ids (appendix C). */
export const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
export const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
/** The serialNumber pattern of the CycloneDX 1.5 JSON schema. */
export const SERIAL_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH = 'cdx:npm:package:path';
const SERIAL_NAME = 'https://github.com/umutcantezgel-cpu/Starpi/sbom/';

/**
 * @typedef {{ name: string, value: string }} Property
 * @typedef {{ 'bom-ref': string, type?: string, name: string, version?: string, scope?: string, purl?: string, properties?: Property[], [key: string]: unknown }} Component
 * @typedef {{ ref: string, dependsOn?: string[] }} Dependency
 * @typedef {{ $schema?: string, bomFormat?: string, specVersion?: string, serialNumber?: string, version?: number, metadata: { timestamp?: string, component: Component, [key: string]: unknown }, components: Component[], dependencies?: Dependency[], [key: string]: unknown }} Bom
 */

/**
 * Name-based UUID, version 5 (SHA-1), RFC 4122 section 4.3.
 * @param {string} name
 * @param {string} [namespace]
 * @returns {string} lowercase, without the urn:uuid: prefix
 */
export function uuidV5(name, namespace = NAMESPACE_URL) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {Component} component */
const pathOf = (component) => component.properties?.find((p) => p.name === PATH)?.value;

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]} the items without repeats, first occurrence kept
 */
const unique = (items) => [...new Set(items)];

/**
 * Merges the copies npm 10 emits for one package installed at several paths: every path is kept,
 * the scope is required when any copy is, and any other property (such as
 * cdx:npm:package:development) is kept only when every copy has it.
 * @param {Component[]} copies
 * @returns {Component}
 */
function mergeCopies(copies) {
  const [first] = copies;
  const key = (/** @type {Property} */ p) => `${p.name}\u0000${p.value}`;
  const shared = copies.slice(1).reduce((keys, c) => new Set((c.properties ?? []).map(key).filter((k) => keys.has(k))), new Set((first.properties ?? []).map(key)));
  const paths = unique(copies.flatMap((c) => (c.properties ?? []).filter((p) => p.name === PATH).map((p) => p.value)));
  /** @type {Property[]} */
  const properties = [];
  for (const p of first.properties ?? []) {
    if (p.name === PATH) {
      if (!properties.some((q) => q.name === PATH)) properties.push(...paths.map((value) => ({ name: PATH, value })));
    } else if (shared.has(key(p))) {
      properties.push(p);
    }
  }
  const merged = { ...first, properties };
  if (copies.some((c) => c.scope === 'required')) merged.scope = 'required';
  return merged;
}

/**
 * Makes an npm sbom document deterministic:
 * - root and workspace components get their package name instead of their directory name
 *   (`names` maps a cdx:npm:package:path, '' for the root, or a bom-ref to the package name; npm 11
 *   no longer writes the path property, the bom-ref works with both);
 * - a bom-ref that npm emits more than once (one package installed at several paths) becomes one
 *   component (see mergeCopies) and one dependency entry with the union of its edges;
 * - metadata.timestamp is `timestamp`, or left out when it is undefined;
 * - serialNumber is a version 5 UUID of the rest of the document, so the same content always has
 *   the same serial number and any change to the content gives a new one.
 * @param {Bom} doc
 * @param {{ names?: Record<string, string>, timestamp?: string }} [options]
 * @returns {Bom} a new document
 */
export function normalizeSbom(doc, { names = {}, timestamp } = {}) {
  const rename = (/** @type {Component} */ component) => {
    const path = pathOf(component);
    const key = path !== undefined && Object.hasOwn(names, path) ? path : component['bom-ref'];
    return Object.hasOwn(names, key) ? { ...component, name: names[key] } : component;
  };

  /** @type {Map<string, Component[]>} */
  const copies = new Map();
  for (const component of doc.components) copies.set(component['bom-ref'], [...(copies.get(component['bom-ref']) ?? []), component]);
  const components = [...copies.values()].map((list) => rename(list.length === 1 ? list[0] : mergeCopies(list)));

  /** @type {Map<string, string[]>} */
  const dependencies = new Map();
  for (const dep of doc.dependencies ?? []) {
    dependencies.set(dep.ref, unique([...(dependencies.get(dep.ref) ?? []), ...(dep.dependsOn ?? [])]));
  }

  const metadata = { ...doc.metadata, component: rename(doc.metadata.component) };
  delete metadata.timestamp;
  return withSerial({
    ...doc,
    metadata: timestamp === undefined ? metadata : { timestamp, ...metadata },
    components,
    dependencies: [...dependencies].map(([ref, dependsOn]) => ({ ref, dependsOn })),
  });
}

/**
 * Turns `npm sbom --workspace <package>` output into the SBOM of that package alone. npm keeps the
 * root project as the main component and adds what the workspace's optional peer dependency
 * resolves to in the root's tree (pdfjs-dist and its own optional dependencies for @starpi/core).
 * A consumer installs an optional peer only if they want to, so it is not part of the package:
 * the package becomes the main component and, because it has no dependencies of its own, the
 * document lists no other component. Anything else the package would install (dependencies,
 * optionalDependencies, bundled or required peer dependencies, or an edge in npm's graph to a
 * package that is not an optional peer) is refused instead of being dropped.
 * @param {Bom} doc  output of npm sbom for the workspace
 * @param {{ ref: string, manifest: Record<string, any> }} pkg  bom-ref and package.json of the package
 * @returns {Bom}
 */
export function normalizeCoreSbom(doc, { ref, manifest }) {
  const optionalPeers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional === true);
  const installs = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...[manifest.bundleDependencies ?? manifest.bundledDependencies ?? []].flat(),
    ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => !optionalPeers.includes(name)),
  ];
  if (installs.length > 0) throw new Error(`${ref} installs ${installs.join(', ')}; normalizeCoreSbom only describes a package without dependencies`);
  const component = doc.components.find((c) => c['bom-ref'] === ref);
  if (!component) throw new Error(`${ref} is not a component of the document`);
  const byRef = new Map(doc.components.map((c) => [c['bom-ref'], c]));
  for (const target of doc.dependencies?.find((d) => d.ref === ref)?.dependsOn ?? []) {
    const name = byRef.get(target)?.name;
    if (!name || !optionalPeers.includes(name)) throw new Error(`${ref} depends on ${target}, which is not an optional peer dependency`);
  }
  return withSerial({
    ...doc,
    metadata: { ...doc.metadata, component: { ...component, type: 'library' } },
    components: [],
    dependencies: [{ ref, dependsOn: [] }],
  });
}

/**
 * @param {Bom} doc
 * @returns {Bom} the document with serialNumber derived from everything else, in npm's key order
 */
function withSerial(doc) {
  const rest = { ...doc };
  delete rest.serialNumber;
  const serialNumber = `urn:uuid:${uuidV5(SERIAL_NAME + JSON.stringify(rest))}`;
  if (!('serialNumber' in doc)) return { ...rest, serialNumber };
  return Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, key === 'serialNumber' ? serialNumber : value]));
}

/**
 * Checks what Starpi relies on in an SBOM. The JSON schema does not check that bom-refs are unique
 * or that dependency edges point at components, so this does.
 * @param {Bom} doc
 * @param {{ name: string, version: string, type: 'application' | 'library', required?: string[], noComponents?: boolean }} expected
 *   `required`: package names that must be listed with scope required;
 *   `noComponents`: the document must list no component besides the main one
 * @returns {string[]} problems, empty when the document is fine
 */
export function validateSbom(doc, expected) {
  /** @type {string[]} */
  const problems = [];
  const check = (/** @type {boolean} */ ok, /** @type {string} */ message) => {
    if (!ok) problems.push(message);
  };
  check(doc.$schema === SCHEMA_URL, `$schema is ${doc.$schema}, expected ${SCHEMA_URL}`);
  check(doc.bomFormat === 'CycloneDX', `bomFormat is ${doc.bomFormat}`);
  check(doc.specVersion === SPEC_VERSION, `specVersion is ${doc.specVersion}, expected ${SPEC_VERSION}`);
  check(Number.isInteger(doc.version) && Number(doc.version) >= 1, `version is ${doc.version}`);
  check(typeof doc.serialNumber === 'string' && SERIAL_PATTERN.test(doc.serialNumber), `serialNumber ${doc.serialNumber} does not match the CycloneDX pattern`);
  if (doc.metadata?.timestamp !== undefined) check(!Number.isNaN(Date.parse(doc.metadata.timestamp)), `metadata.timestamp ${doc.metadata.timestamp} is not a date`);

  const main = doc.metadata?.component;
  check(main?.name === expected.name, `main component is ${main?.name}, expected ${expected.name}`);
  check(main?.version === expected.version, `main component version is ${main?.version}, expected ${expected.version}`);
  check(main?.type === expected.type, `main component type is ${main?.type}, expected ${expected.type}`);
  check(typeof main?.purl === 'string' && main.purl.startsWith('pkg:npm/'), `main component purl is ${main?.purl}`);

  const components = Array.isArray(doc.components) ? doc.components : [];
  check(Array.isArray(doc.components), 'components is not an array');
  const refs = new Set([main?.['bom-ref']]);
  for (const component of components) {
    const ref = component['bom-ref'];
    check(typeof ref === 'string' && ref.length > 0, `component ${component.name} has no bom-ref`);
    check(!refs.has(ref), `bom-ref ${ref} is not unique`);
    refs.add(ref);
    check(typeof component.purl === 'string' && component.purl.startsWith('pkg:npm/'), `component ${ref} has no npm purl`);
  }
  for (const dep of doc.dependencies ?? []) {
    check(refs.has(dep.ref), `dependency entry for unknown ref ${dep.ref}`);
    for (const target of dep.dependsOn ?? []) check(refs.has(target), `${dep.ref} depends on unknown ref ${target}`);
  }
  if (expected.noComponents) check(components.length === 0, `expected no components, found ${components.length}`);
  for (const name of expected.required ?? []) {
    check(components.some((c) => c.name === name && c.scope === 'required'), `runtime dependency ${name} is not listed with scope required`);
  }
  return problems;
}
