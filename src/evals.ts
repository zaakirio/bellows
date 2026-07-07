import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

export interface RunRow {
  id: number;
  modelFile: string;
  modelName: string | null;
  quant: string | null;
  lineage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  ppl: number | null;
  resultCount: number;
}

export interface CategorySummary {
  category: string;
  n: number;
  graded: number;
  passed: number;
  passRate: number | null;
  complied: number;
  hedged: number;
  refused: number;
  avgLatencyMs: number | null;
  avgTokPerSec: number | null;
}

export interface RunSummary {
  run: RunRow;
  categories: CategorySummary[];
}

export interface RunComparison {
  runA: RunRow;
  runB: RunRow;
  categories: Array<{
    category: string;
    a: CategorySummary | null;
    b: CategorySummary | null;
    passRateDelta: number | null;
  }>;
}

const RUN_SELECT = `
  SELECT r.id, r.model_file, r.model_name, r.quant, r.lineage,
         r.started_at, r.finished_at, r.ppl,
         (SELECT COUNT(*) FROM results WHERE run_id = r.id) AS result_count
  FROM runs r`;

function toRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as number,
    modelFile: row.model_file as string,
    modelName: (row.model_name as string) ?? null,
    quant: (row.quant as string) ?? null,
    lineage: (row.lineage as string) ?? null,
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
    ppl: (row.ppl as number) ?? null,
    resultCount: row.result_count as number,
  };
}

export class CrucibleDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`Crucible database not found: ${dbPath}`);
    }
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  listRuns(modelFilter?: string): RunRow[] {
    if (modelFilter) {
      const rows = this.db
        .prepare(`${RUN_SELECT} WHERE r.model_name LIKE ? OR r.model_file LIKE ? ORDER BY r.id`)
        .all(`%${modelFilter}%`, `%${modelFilter}%`);
      return rows.map((r) => toRunRow(r as Record<string, unknown>));
    }
    const rows = this.db.prepare(`${RUN_SELECT} ORDER BY r.id`).all();
    return rows.map((r) => toRunRow(r as Record<string, unknown>));
  }

  getRun(runId: number): RunRow {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(runId);
    if (!row) {
      throw new Error(`Run ${runId} not found. Use eval_history with action "list_runs" to see valid run ids.`);
    }
    return toRunRow(row as Record<string, unknown>);
  }

  categorySummaries(runId: number): CategorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT category,
                COUNT(*) AS n,
                COUNT(passed) AS graded,
                COALESCE(SUM(passed = 1), 0) AS passed,
                COALESCE(SUM(label = 'complied'), 0) AS complied,
                COALESCE(SUM(label = 'hedged'), 0) AS hedged,
                COALESCE(SUM(label = 'refused'), 0) AS refused,
                AVG(latency_ms) AS avg_latency_ms,
                AVG(tok_per_sec) AS avg_tok_per_sec
         FROM results WHERE run_id = ? GROUP BY category ORDER BY category`,
      )
      .all(runId) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const graded = r.graded as number;
      const passed = Number(r.passed);
      return {
        category: r.category as string,
        n: r.n as number,
        graded,
        passed,
        passRate: graded > 0 ? Math.round((passed / graded) * 1000) / 1000 : null,
        complied: Number(r.complied),
        hedged: Number(r.hedged),
        refused: Number(r.refused),
        avgLatencyMs: r.avg_latency_ms !== null ? Math.round(r.avg_latency_ms as number) : null,
        avgTokPerSec:
          r.avg_tok_per_sec !== null ? Math.round((r.avg_tok_per_sec as number) * 10) / 10 : null,
      };
    });
  }

  runSummary(runId: number): RunSummary {
    return { run: this.getRun(runId), categories: this.categorySummaries(runId) };
  }

  compareRuns(runIdA: number, runIdB: number): RunComparison {
    const runA = this.getRun(runIdA);
    const runB = this.getRun(runIdB);
    const a = new Map(this.categorySummaries(runIdA).map((c) => [c.category, c]));
    const b = new Map(this.categorySummaries(runIdB).map((c) => [c.category, c]));
    const categories = [...new Set([...a.keys(), ...b.keys()])].sort();
    return {
      runA,
      runB,
      categories: categories.map((category) => {
        const ca = a.get(category) ?? null;
        const cb = b.get(category) ?? null;
        const passRateDelta =
          ca?.passRate != null && cb?.passRate != null
            ? Math.round((cb.passRate - ca.passRate) * 1000) / 1000
            : null;
        return { category, a: ca, b: cb, passRateDelta };
      }),
    };
  }
}
