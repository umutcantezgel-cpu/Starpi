// @ts-check
// Every feature module, imported for its registrations (registry.js). main.js imports this file and
// mounts them at boot. A feature package replaces the body of its own stub; adding a new feature
// adds one import here.
import './canvas.js';
import './companion.js';
import './conversations.js';
import './live.js';
import './memory.js';
import './providers.js';
import './research.js';
import './sources.js';
import './sync.js';
import './trust.js';
import './voice.js';
import './workspace.js';

export { listFeatures, MOUNT_POINTS, mountFeatures, registerFeature } from './registry.js';
