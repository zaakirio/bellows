#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { buildServer, createSupervisor, type BellowsDeps } from "./server.ts";
import { startHttpServer } from "./http.ts";

const { values } = parseArgs({
  options: {
    http: { type: "boolean", default: false },
    port: { type: "string", default: "8765" },
    host: { type: "string", default: "127.0.0.1" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`bellows - MCP server for a local llama.cpp model fleet

Usage:
  bellows              stdio transport (for Claude Code / Claude Desktop)
  bellows --http       streamable HTTP transport on --port (default 8765)
                       binds --host (default 127.0.0.1; 0.0.0.0 in containers)

Environment:
  BELLOWS_MODELS_DIR    directory scanned for .gguf models
  BELLOWS_LLAMA_SERVER  path to the llama-server binary
  BELLOWS_CRUCIBLE_DB   path to the crucible results.db (opened read-only)`);
  process.exit(0);
}

const config = loadConfig();
const supervisor = createSupervisor(config);
const deps: BellowsDeps = { config, supervisor };

async function shutdown(): Promise<void> {
  // Reap llama-server children before exiting; otherwise they are orphaned.
  await supervisor.stopAll();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (values.http) {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port: ${values.port}`);
    process.exit(1);
  }
  startHttpServer(deps, port, values.host);
} else {
  const server = buildServer(deps);
  // MCP clients signal shutdown by closing stdin, not only by signal; without this,
  // a client that just closes the pipe leaves bellows and its children running.
  process.stdin.on("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
  console.error("bellows: stdio transport connected");
}
