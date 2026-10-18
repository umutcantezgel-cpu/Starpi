#!/usr/bin/env node
// starpi-companion: the command line of Starpi Core, the local companion.
// node:sqlite prints an experimental warning on Node 22; it is expected here and only that one is
// hidden, every other warning still reaches stderr.
const defaultHandlers = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const handler of defaultHandlers) handler.call(process, warning);
});

const { main } = await import('../src/cli/main.js');
process.exitCode = await main(process.argv.slice(2));
