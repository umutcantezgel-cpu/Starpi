#!/usr/bin/env node
// Alias of scripts/sync-model-catalog.mjs that never asks a provider (`npm run nvidia:sync`): it
// rewrites backend/core/nvidia_catalog.json, the Python backend's copy of the NVIDIA allowlist,
// from src/js/models/nvidia-catalog.js, and the NVIDIA section of the model catalog snapshot.
//
// Usage: npm run nvidia:sync            rewrite the copies
//        npm run nvidia:sync -- --check exit 1 if a copy is outdated, change nothing
import { main } from './sync-model-catalog.mjs';

process.exitCode = await main(['--offline', ...process.argv.slice(2)]);
