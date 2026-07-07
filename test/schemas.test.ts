import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, createSupervisor } from "../src/server.ts";
import type { BellowsConfig } from "../src/config.ts";

const config: BellowsConfig = {
  modelsDir: undefined,
  llamaServerBin: undefined,
  crucibleDb: undefined,
};

describe("MCP surface", () => {
  let client: Client;

  before(async () => {
    const server = buildServer({ config, supervisor: createSupervisor(config) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
  });

  test("exposes exactly the six fleet tools, each with a description and input schema", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["eval_history", "list_models", "server_status", "smoke_test", "start_server", "stop_server"],
    );
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  test("exposes models and eval-runs resources", async () => {
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((r) => r.uri).sort(),
      ["bellows://eval-runs", "bellows://models"],
    );
  });

  test("start_server rejects an out-of-range port at the schema layer", async () => {
    const result = await client.callTool({
      name: "start_server",
      arguments: { model: "x", port: 80 },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments/);
  });

  test("smoke_test requires a port", async () => {
    const result = await client.callTool({ name: "smoke_test", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments/);
  });

  test("eval_history rejects an unknown action", async () => {
    const result = await client.callTool({
      name: "eval_history",
      arguments: { action: "drop_tables" },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments/);
  });

  test("eval_history run_summary without runId returns a tool error, not a crash", async () => {
    const result = await client.callTool({
      name: "eval_history",
      arguments: { action: "run_summary" },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /requires runId/);
  });

  test("unconfigured paths produce actionable error messages", async () => {
    const result = await client.callTool({ name: "list_models", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /BELLOWS_MODELS_DIR/);
  });

  test("stop_server on an unowned port refuses politely", async () => {
    const result = await client.callTool({ name: "stop_server", arguments: { port: 8080 } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /only stops processes it started/);
  });
});
