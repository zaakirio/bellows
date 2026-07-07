import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSetting, type BellowsConfig } from "./config.ts";
import { scanModels } from "./models.ts";
import { Supervisor, probeHealth, fetchServerProps } from "./supervisor.ts";
import { smokeTest, DEFAULT_SMOKE_PROMPTS } from "./smoke.ts";
import { CrucibleDb } from "./evals.ts";

const listModelsInput = {
  dir: z
    .string()
    .optional()
    .describe("Directory to scan recursively for .gguf files. Defaults to BELLOWS_MODELS_DIR."),
};

const serverStatusInput = {
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("Also probe this port for a llama-server health endpoint, owned by bellows or not."),
};

const startServerInput = {
  model: z
    .string()
    .min(1)
    .describe(
      "Model to serve: an absolute path to a .gguf file, or a substring matched against the scanned models list (e.g. 'lfm2.5' or 'Q4_K_M').",
    ),
  port: z.number().int().min(1024).max(65535).default(8080).describe("HTTP port for llama-server."),
  ngl: z.number().int().min(0).max(999).default(99).describe("GPU layers to offload (99 = all)."),
  ctx: z.number().int().min(256).max(1_048_576).default(4096).describe("Context window in tokens."),
  readyTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .default(120_000)
    .describe("How long to wait for the /health endpoint before giving up and killing the process."),
};

const stopServerInput = {
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe("Port of the bellows-owned server to stop. Bellows refuses to stop servers it did not start."),
};

const smokeTestInput = {
  port: z.number().int().min(1).max(65535).describe("Port of a running llama-server."),
  prompts: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe("Prompts to send. Defaults to three short sanity prompts."),
  maxTokens: z.number().int().min(1).max(4096).default(128).describe("max_tokens per completion."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(60_000)
    .describe("Per-request timeout in milliseconds."),
};

const evalHistoryInput = {
  action: z
    .enum(["list_runs", "run_summary", "compare_runs"])
    .describe(
      "list_runs: all eval runs (optionally filtered by model). run_summary: per-category pass rates and complied/hedged/refused tallies for one run (requires runId). compare_runs: side-by-side category deltas (requires runA and runB).",
    ),
  model: z.string().optional().describe("For list_runs: substring filter on model name or file."),
  runId: z.number().int().optional().describe("For run_summary: the run id."),
  runA: z.number().int().optional().describe("For compare_runs: baseline run id."),
  runB: z.number().int().optional().describe("For compare_runs: comparison run id."),
};

const modelEntryShape = z.object({
  name: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  sizeHuman: z.string(),
  quant: z.string().nullable(),
  sharded: z.boolean(),
  shardCount: z.number().optional(),
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface BellowsDeps {
  config: BellowsConfig;
  supervisor: Supervisor;
}

export function createSupervisor(config: BellowsConfig): Supervisor {
  return new Supervisor(config.llamaServerBin ?? "");
}

export function buildServer(deps: BellowsDeps): McpServer {
  const { config, supervisor } = deps;

  const server = new McpServer({
    name: "bellows",
    version: "0.1.0",
  });

  const openDb = () =>
    new CrucibleDb(requireSetting(config.crucibleDb, "BELLOWS_CRUCIBLE_DB", "crucible eval database"));

  const resolveModelsDir = (dir?: string) =>
    dir ?? requireSetting(config.modelsDir, "BELLOWS_MODELS_DIR", "models directory");

  server.registerTool(
    "list_models",
    {
      title: "List local GGUF models",
      description:
        "Scan a directory recursively for runnable .gguf model files (skipping mmproj-* projector files). Returns name, path, size, a quant guess from the filename, and sharded-set detection.",
      inputSchema: listModelsInput,
      outputSchema: {
        dir: z.string(),
        count: z.number(),
        models: z.array(modelEntryShape),
      },
    },
    async ({ dir }) => {
      try {
        const scanDir = resolveModelsDir(dir);
        const models = await scanModels(scanDir);
        return ok({ dir: scanDir, count: models.length, models });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "server_status",
    {
      title: "llama-server status",
      description:
        "Report all llama-server processes bellows is supervising (pid, port, model, uptime) and optionally probe a specific port's /health endpoint, including servers bellows does not own.",
      inputSchema: serverStatusInput,
      outputSchema: {
        ownedServers: z.array(
          z.object({
            pid: z.number(),
            port: z.number(),
            modelPath: z.string(),
            startedAt: z.string(),
            uptimeSeconds: z.number(),
            alive: z.boolean(),
            healthy: z.boolean(),
          }),
        ),
        probe: z
          .object({
            port: z.number(),
            healthy: z.boolean(),
            ownedByBellows: z.boolean(),
            model: z.string().nullable(),
          })
          .optional(),
      },
    },
    async ({ port }) => {
      try {
        const ownedServers = await Promise.all(
          supervisor.list().map(async (s) => ({
            ...s,
            healthy: s.alive ? await probeHealth(s.port) : false,
          })),
        );
        const structured: Record<string, unknown> = { ownedServers };
        if (port !== undefined) {
          const healthy = await probeHealth(port);
          const props = healthy ? await fetchServerProps(port) : null;
          structured.probe = {
            port,
            healthy,
            ownedByBellows: supervisor.owns(port),
            model: typeof props?.model_path === "string" ? props.model_path : null,
          };
        }
        return ok(structured);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "start_server",
    {
      title: "Start a llama-server",
      description:
        "Spawn llama-server for a model (full arg validation, no shell), wait for its /health endpoint to report ready, and record the pid under bellows supervision. Refuses to start if the port is already in use.",
      inputSchema: startServerInput,
      outputSchema: {
        pid: z.number(),
        port: z.number(),
        modelPath: z.string(),
        startedAt: z.string(),
        apiBase: z.string(),
      },
    },
    async ({ model, port, ngl, ctx, readyTimeoutMs }) => {
      try {
        let modelPath = model;
        if (!model.startsWith("/")) {
          const dir = resolveModelsDir();
          const models = await scanModels(dir);
          const needle = model.toLowerCase();
          const matches = models.filter(
            (m) => m.name.toLowerCase().includes(needle) || m.path.toLowerCase().includes(needle),
          );
          if (matches.length === 0) {
            throw new Error(
              `No model matching "${model}" under ${dir}. Use list_models to see what is available.`,
            );
          }
          if (matches.length > 1) {
            throw new Error(
              `"${model}" matches ${matches.length} models: ${matches.map((m) => m.name).join(", ")}. Be more specific or pass an absolute path.`,
            );
          }
          modelPath = matches[0]!.path;
        }
        requireSetting(config.llamaServerBin, "BELLOWS_LLAMA_SERVER", "llama-server binary");
        const started = await supervisor.start({ modelPath, port, ngl, ctx, readyTimeoutMs });
        return ok({ ...started, apiBase: `http://127.0.0.1:${port}/v1` });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "stop_server",
    {
      title: "Stop a bellows-owned llama-server",
      description:
        "Gracefully stop (SIGTERM, then SIGKILL after a grace period) a llama-server that bellows started. Refuses to touch processes it does not own.",
      inputSchema: stopServerInput,
      outputSchema: {
        port: z.number(),
        pid: z.number(),
        exitCode: z.number().nullable(),
        forced: z.boolean(),
      },
    },
    async ({ port }) => {
      try {
        const result = await supervisor.stop(port);
        return ok({ port, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "smoke_test",
    {
      title: "Smoke-test a running server",
      description:
        "Send a batch of chat prompts to a running llama-server over its OpenAI-compatible API and report each response with latency and generation speed (tokens/second as measured by llama.cpp).",
      inputSchema: smokeTestInput,
      outputSchema: {
        port: z.number(),
        prompts: z.number(),
        results: z.array(
          z.object({
            prompt: z.string(),
            response: z.string(),
            latencyMs: z.number(),
            completionTokens: z.number().nullable(),
            tokPerSec: z.number().nullable(),
          }),
        ),
        meanLatencyMs: z.number(),
        meanTokPerSec: z.number().nullable(),
      },
    },
    async ({ port, prompts, maxTokens, timeoutMs }) => {
      try {
        const summary = await smokeTest({
          port,
          prompts: prompts ?? DEFAULT_SMOKE_PROMPTS,
          maxTokens,
          timeoutMs,
        });
        return ok({ ...summary });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "eval_history",
    {
      title: "Query crucible eval history",
      description:
        "Read-only queries against the crucible eval results database: list runs for a model, summarize one run per category (pass rates plus complied/hedged/refused tallies), or compare two runs.",
      inputSchema: evalHistoryInput,
    },
    async ({ action, model, runId, runA, runB }) => {
      let db: CrucibleDb | undefined;
      try {
        if (action === "run_summary" && runId === undefined) {
          throw new Error('action "run_summary" requires runId.');
        }
        if (action === "compare_runs" && (runA === undefined || runB === undefined)) {
          throw new Error('action "compare_runs" requires both runA and runB.');
        }
        db = openDb();
        if (action === "list_runs") {
          const runs = db.listRuns(model);
          return ok({ count: runs.length, runs });
        }
        if (action === "run_summary") {
          return ok({ ...db.runSummary(runId!) });
        }
        return ok({ ...db.compareRuns(runA!, runB!) });
      } catch (err) {
        return fail(err);
      } finally {
        db?.close();
      }
    },
  );

  server.registerResource(
    "models",
    "bellows://models",
    {
      title: "Local GGUF models",
      description: "JSON list of runnable GGUF models in the configured models directory.",
      mimeType: "application/json",
    },
    async (uri) => {
      const dir = resolveModelsDir();
      const models = await scanModels(dir);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ dir, count: models.length, models }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "eval-runs",
    "bellows://eval-runs",
    {
      title: "Crucible eval runs",
      description: "JSON list of all eval runs recorded in the crucible results database.",
      mimeType: "application/json",
    },
    async (uri) => {
      const db = openDb();
      try {
        const runs = db.listRuns();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ count: runs.length, runs }, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    },
  );

  return server;
}
