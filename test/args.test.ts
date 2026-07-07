import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServerArgs, Supervisor } from "../src/supervisor.ts";

describe("buildServerArgs", () => {
  test("builds a plain argv array with no shell interpolation surface", () => {
    const args = buildServerArgs({
      modelPath: "/models/weird name; rm -rf $(whoami).gguf",
      port: 8091,
      ngl: 99,
      ctx: 4096,
    });
    assert.deepEqual(args, [
      "-m", "/models/weird name; rm -rf $(whoami).gguf",
      "--port", "8091",
      "--host", "127.0.0.1",
      "-ngl", "99",
      "--ctx-size", "4096",
      "--flash-attn", "auto",
      "--jinja",
    ]);
  });

  test("binds the server to loopback only", () => {
    const args = buildServerArgs({ modelPath: "/m.gguf", port: 1234, ngl: 0, ctx: 512 });
    const hostIdx = args.indexOf("--host");
    assert.equal(args[hostIdx + 1], "127.0.0.1");
  });
});

describe("Supervisor ownership", () => {
  test("refuses to stop a port it does not own", async () => {
    const sup = new Supervisor("/nonexistent/llama-server");
    await assert.rejects(() => sup.stop(8080), /only stops processes it started/);
  });

  test("refuses to start with a missing model file", async () => {
    const sup = new Supervisor("/nonexistent/llama-server");
    await assert.rejects(
      () =>
        sup.start({
          modelPath: "/nonexistent/model.gguf",
          port: 8099,
          ngl: 99,
          ctx: 2048,
          readyTimeoutMs: 5000,
        }),
      /Model file not found/,
    );
  });

  test("refuses to start with a missing llama-server binary", async () => {
    const sup = new Supervisor("/nonexistent/llama-server");
    await assert.rejects(
      () =>
        sup.start({
          modelPath: process.execPath,
          port: 8099,
          ngl: 99,
          ctx: 2048,
          readyTimeoutMs: 5000,
        }),
      /llama-server binary not found/,
    );
  });

  test("lists nothing before any start", () => {
    const sup = new Supervisor("/nonexistent/llama-server");
    assert.deepEqual(sup.list(), []);
    assert.equal(sup.owns(8080), false);
  });
});
