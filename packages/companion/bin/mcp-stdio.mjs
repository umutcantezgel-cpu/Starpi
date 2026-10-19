#!/usr/bin/env node
// starpi-companion-mcp: lets a desktop MCP client use the read-only tools of Starpi Core.
//
//   starpi-companion-mcp --token-file <file> [--port <port>]
//
// The client starts this program and talks to it over standard input and output; the program
// passes every message on to the companion on 127.0.0.1 (src/mcp/bridge.js). The token comes from
// a file only, never from an argument: a regular file of the user running the bridge that nobody
// else may read (chmod 600). Create the token in the Starpi app (Companion > MCP clients) or with
// POST /v1/mcp/clients as the owner, and save it in that file. The port defaults to
// STARPI_COMPANION_PORT, else 47821.
//
// A client configuration may look like this:
//   { "mcpServers": { "starpi": { "command": "starpi-companion-mcp",
//                                 "args": ["--token-file", "<absolute path>/mcp.token"] } } }
const { bridgeMain } = await import('../src/mcp/bridge.js');
process.stdout.on('error', () => process.exit(0));
process.exitCode = await bridgeMain(process.argv.slice(2));
