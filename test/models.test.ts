import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { guessQuant, humanSize, scanModels } from "../src/models.ts";

describe("guessQuant", () => {
  test("recognises common llama.cpp quant labels", () => {
    assert.equal(guessQuant("LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M.gguf"), "Q4_K_M");
    assert.equal(guessQuant("model-Q3_K_M.gguf"), "Q3_K_M");
    assert.equal(guessQuant("model-Q8_0.gguf"), "Q8_0");
    assert.equal(guessQuant("model-Q6_K.gguf"), "Q6_K");
    assert.equal(guessQuant("model-IQ4_XS.gguf"), "IQ4_XS");
    assert.equal(guessQuant("model-F16.gguf"), "F16");
    assert.equal(guessQuant("model.BF16.gguf"), "BF16");
  });

  test("is case-insensitive and takes the last quant-looking token", () => {
    assert.equal(guessQuant("some-q4_k_m.gguf"), "Q4_K_M");
    assert.equal(guessQuant("f16-distilled-Q5_K_M.gguf"), "Q5_K_M");
  });

  test("returns null when no quant is present", () => {
    assert.equal(guessQuant("mtp-gemma-4-12b-it-uncensored.gguf"), null);
  });
});

describe("humanSize", () => {
  test("formats bytes, MiB and GiB", () => {
    assert.equal(humanSize(512), "512 B");
    assert.equal(humanSize(730895520), "697.0 MiB");
    assert.equal(humanSize(7381381760), "6.87 GiB");
  });
});

describe("scanModels", () => {
  test("finds gguf files recursively, skips mmproj, groups shards", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bellows-models-"));
    try {
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "alpha-Q4_K_M.gguf"), Buffer.alloc(1024));
      await writeFile(path.join(dir, "mmproj-alpha-bf16.gguf"), Buffer.alloc(64));
      await writeFile(path.join(dir, "notes.txt"), "not a model");
      await writeFile(path.join(dir, "sub", "beta-Q8_0.gguf"), Buffer.alloc(2048));
      await writeFile(path.join(dir, "sub", "big-F16-00001-of-00002.gguf"), Buffer.alloc(100));
      await writeFile(path.join(dir, "sub", "big-F16-00002-of-00002.gguf"), Buffer.alloc(150));

      const models = await scanModels(dir);
      assert.deepEqual(
        models.map((m) => m.name),
        ["alpha-Q4_K_M", "beta-Q8_0", "big-F16"],
      );

      const alpha = models[0]!;
      assert.equal(alpha.quant, "Q4_K_M");
      assert.equal(alpha.sizeBytes, 1024);
      assert.equal(alpha.sharded, false);

      const sharded = models[2]!;
      assert.equal(sharded.sharded, true);
      assert.equal(sharded.shardCount, 2);
      assert.equal(sharded.sizeBytes, 250);
      assert.ok(sharded.path.endsWith("big-F16-00001-of-00002.gguf"));
      assert.equal(sharded.quant, "F16");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a missing directory with a clear error", async () => {
    await assert.rejects(
      () => scanModels("/nonexistent/bellows-test-dir"),
      /Models directory not found/,
    );
  });
});
