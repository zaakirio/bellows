import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { CrucibleDb } from "../src/evals.ts";

const DB_PATH =
  process.env.BELLOWS_CRUCIBLE_DB ??
  new URL("../../../../crucible/results.db", import.meta.url).pathname;

const dbAvailable = existsSync(DB_PATH);

describe("CrucibleDb", { skip: dbAvailable ? false : `crucible db not found at ${DB_PATH}` }, () => {
  test("constructor rejects a missing db path", () => {
    assert.throws(() => new CrucibleDb("/nonexistent/results.db"), /database not found/);
  });

  test("listRuns returns runs with result counts", () => {
    const db = new CrucibleDb(DB_PATH);
    try {
      const runs = db.listRuns();
      assert.ok(runs.length > 0, "expected at least one run");
      const first = runs[0]!;
      assert.equal(typeof first.id, "number");
      assert.equal(typeof first.modelFile, "string");
      assert.equal(typeof first.resultCount, "number");
    } finally {
      db.close();
    }
  });

  test("listRuns filters by model substring", () => {
    const db = new CrucibleDb(DB_PATH);
    try {
      const all = db.listRuns();
      const filtered = db.listRuns("LFM2.5");
      assert.ok(filtered.length > 0);
      assert.ok(filtered.length <= all.length);
      for (const run of filtered) {
        const haystack = `${run.modelName ?? ""} ${run.modelFile}`;
        assert.match(haystack, /LFM2\.5/);
      }
    } finally {
      db.close();
    }
  });

  test("runSummary aggregates categories with consistent tallies", () => {
    const db = new CrucibleDb(DB_PATH);
    try {
      const runId = db.listRuns()[0]!.id;
      const summary = db.runSummary(runId);
      assert.equal(summary.run.id, runId);
      assert.ok(summary.categories.length > 0);
      let total = 0;
      for (const cat of summary.categories) {
        total += cat.n;
        assert.ok(cat.graded <= cat.n);
        assert.ok(cat.passed <= cat.graded);
        if (cat.passRate !== null) {
          assert.ok(cat.passRate >= 0 && cat.passRate <= 1);
        }
        assert.ok(cat.complied + cat.hedged + cat.refused <= cat.n);
      }
      assert.equal(total, summary.run.resultCount);
    } finally {
      db.close();
    }
  });

  test("compareRuns joins categories from both runs and computes deltas", () => {
    const db = new CrucibleDb(DB_PATH);
    try {
      const runs = db.listRuns();
      assert.ok(runs.length >= 2, "need two runs to compare");
      const [a, b] = [runs[0]!.id, runs[1]!.id];
      const cmp = db.compareRuns(a, b);
      assert.equal(cmp.runA.id, a);
      assert.equal(cmp.runB.id, b);
      assert.ok(cmp.categories.length > 0);
      for (const row of cmp.categories) {
        if (row.passRateDelta !== null) {
          assert.ok(row.a?.passRate != null && row.b?.passRate != null);
          assert.ok(Math.abs(row.passRateDelta - (row.b.passRate - row.a.passRate)) < 1e-9);
        }
      }
    } finally {
      db.close();
    }
  });

  test("unknown run id raises a helpful error", () => {
    const db = new CrucibleDb(DB_PATH);
    try {
      assert.throws(() => db.runSummary(999_999), /Run 999999 not found/);
    } finally {
      db.close();
    }
  });
});
