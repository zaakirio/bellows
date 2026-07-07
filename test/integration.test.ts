import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, createSupervisor } from "../src/server.ts";
import type { BellowsConfig } from "../src/config.ts";
import type { Supervisor } from "../src/supervisor.ts";

// Defaults assume bellows sits inside an inference workspace three levels up
// (<workspace>/portfolio/projects/bellows); override with BELLOWS_* for other layouts.
const workspace = new URL("../../../..", import.meta.url).pathname;

const config: BellowsConfig = {
  modelsDir: process.env.BELLOWS_MODELS_DIR ?? `${workspace}models`,
  llamaServerBin:
    process.env.BELLOWS_LLAMA_SERVER ?? `${workspace}llama.cpp/build/bin/llama-server`,
  crucibleDb: process.env.BELLOWS_CRUCIBLE_DB ?? `${workspace}crucible/results.db`,
};

const MODEL_MATCH = "LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M";
const PORT = 8091;

const skip = !existsSync(config.llamaServerBin!)
  ? `llama-server binary not found at ${config.llamaServerBin}; skipping live integration test`
  : !existsSync(config.modelsDir!)
    ? `models directory not found at ${config.modelsDir}; skipping live integration test`
    : false;

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("live llama-server lifecycle", { skip, timeout: 300_000 }, () => {
  let client: Client;
  let supervisor: Supervisor;

  after(async () => {
    // Never leave a llama-server behind, even if an assertion failed mid-run.
    await supervisor?.stopAll();
    await client?.close();
  });

  test("start, status, smoke-test, stop", { timeout: 300_000 }, async (t) => {
    supervisor = createSupervisor(config);
    const server = buildServer({ config, supervisor });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "integration", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const models = structured(await client.callTool({ name: "list_models", arguments: {} }));
    assert.ok((models.count as number) > 0, "expected at least one model in the fleet");
    const target = (models.models as Array<{ name: string }>).find((m) =>
      m.name.includes(MODEL_MATCH),
    );
    if (!target) {
      t.skip(`model ${MODEL_MATCH} not present; skipping live server test`);
      return;
    }

    const started = structured(
      await client.callTool({
        name: "start_server",
        arguments: { model: MODEL_MATCH, port: PORT, ctx: 2048 },
      }),
    );
    assert.equal(started.port, PORT);
    assert.ok((started.pid as number) > 0);
    console.log("started:", JSON.stringify(started));

    const dup = await client.callTool({
      name: "start_server",
      arguments: { model: MODEL_MATCH, port: PORT },
    });
    assert.equal(dup.isError, true, "second start on same port must be refused");

    const status = structured(
      await client.callTool({ name: "server_status", arguments: { port: PORT } }),
    );
    const probe = status.probe as { healthy: boolean; ownedByBellows: boolean };
    assert.equal(probe.healthy, true);
    assert.equal(probe.ownedByBellows, true);
    console.log("status:", JSON.stringify(status));

    const smoke = structured(
      await client.callTool({ name: "smoke_test", arguments: { port: PORT } }),
    );
    const results = smoke.results as Array<{ response: string; latencyMs: number }>;
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.ok(r.response.length > 0, "each prompt must get a non-empty response");
      assert.ok(r.latencyMs > 0);
    }
    console.log("smoke:", JSON.stringify(smoke, null, 2));

    const stopped = structured(
      await client.callTool({ name: "stop_server", arguments: { port: PORT } }),
    );
    assert.equal(stopped.port, PORT);
    console.log("stopped:", JSON.stringify(stopped));

    const statusAfter = structured(
      await client.callTool({ name: "server_status", arguments: { port: PORT } }),
    );
    assert.equal((statusAfter.probe as { healthy: boolean }).healthy, false);
    assert.equal((statusAfter.ownedServers as unknown[]).length, 0);
  });
});
