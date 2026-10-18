// @ts-check
// @starpi/companion: Starpi Core, the local companion. The kernel's public surface for embedding,
// for modules and for tests; the command line is bin/starpi-companion.mjs.
export { startCompanion, checkBeforeStart } from './service.js';
export { loadConfig, checkConfig, defaultPaths } from './config.js';
export { openInstallation, isFresh } from './installation.js';
export { VERSION } from './version.js';
export * from './contracts/index.js';
export { auditHeadMessage, recordHash, verifyChain } from './audit/chain.js';
export { checkAnchors, readAnchors } from './audit/anchors.js';
export { verifyInstallation } from './audit/verify.js';
export { publicKeyFromRaw, verifySignature } from './audit/identity.js';
export { canonicalJson, sha256Hex } from './lib/canonical.js';
export { CompanionError } from './lib/errors.js';
export { createRouteTable } from './server/http.js';
export { createBrainRouter } from './brain/router.js';
export { createNoneBrain, TEMPLATE_TEXTS } from './brain/none.js';
export { createSpliceServer } from './egress/splice.js';
export { minimalProfile, demoReadings, latestReadings } from './profiles/minimal/index.js';
