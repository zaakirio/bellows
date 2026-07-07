<p align="center"><img src="assets/banner.svg" alt="" width="100%"></p>

# Bellows

An MCP (Model Context Protocol) server that manages a local llama.cpp model fleet.
It lets an AI agent (Claude Code, Claude Desktop, or any MCP client) discover GGUF models on disk, start and stop `llama-server` processes safely, smoke-test running servers, and query historical eval results from a [crucible](https://github.com/zaakirio/crucible) SQLite database.

Bellows is the piece that turns "a directory full of GGUF files and a llama-server binary" into something an agent can operate: it owns the process lifecycle, refuses to touch anything it did not start, and reports structured JSON for every operation.
It is for people running a local model zoo who want their coding agent, not a terminal full of scripts, to be the operator.
Headline numbers, measured on Apple M4 Pro 24 GB on 2026-07-07 (caveats in [Measured numbers](#measured-numbers-and-their-caveats)): 27/27 tests green, and the full start -> status -> smoke -> stop lifecycle for a 697 MiB model completes in 716 ms warm through real MCP tool calls.

## Why MCP

Managing a local inference fleet is a tool-use problem, not a chat problem.
The operations (scan disk, spawn a server, poll health, run prompts, aggregate eval rows) are exactly the shape MCP tools are designed for: typed inputs, structured outputs, and clear error semantics.
Exposing them over MCP means any compliant client gets the whole workflow for free, instead of shelling out to ad-hoc scripts with no validation and no ownership tracking.

## Architecture

```
┌──────────────┐  stdio / streamable HTTP  ┌───────────────────────────────┐
│  MCP client  │ ◄───────────────────────► │  bellows (Node 24, TS)        │
│ (Claude Code)│                           │                               │
└──────────────┘                           │  models.ts    fs scan         │
                                           │  supervisor.ts spawn/health   │──► llama-server (child procs)
                                           │  smoke.ts     OpenAI-compat   │──► http://127.0.0.1:<port>/v1
                                           │  evals.ts     node:sqlite RO  │──► crucible results.db
                                           └───────────────────────────────┘
```

- `src/index.ts` parses CLI flags and picks the transport (stdio by default, streamable HTTP with `--http`).
- `src/server.ts` registers the six tools and two resources on an `McpServer` from the official SDK.
- `src/supervisor.ts` is the process owner: it spawns `llama-server` with an argv array (never a shell string), polls `/health` until ready, keeps a stderr tail for diagnostics, and only ever signals PIDs it spawned itself.
- `src/evals.ts` opens the crucible database with `node:sqlite` in read-only mode and runs aggregate queries.
- `src/models.ts` scans a directory tree for `.gguf` files, skips `mmproj-*` projector files, guesses the quant from the filename, and collapses sharded `-00001-of-000NN` sets into one entry.

## Tool catalog

| Tool | What it does | Key inputs |
|---|---|---|
| `list_models` | Recursive GGUF scan: name, path, size, quant guess, shard detection. Skips `mmproj-*`. | `dir?` |
| `server_status` | Lists every bellows-owned server (pid, model, uptime, health) and optionally probes any port. | `port?` |
| `start_server` | Spawns `llama-server`, waits for `/health`, records the pid. Refuses if the port is taken. Accepts a path or a fuzzy model name. | `model`, `port?`, `ngl?`, `ctx?`, `readyTimeoutMs?` |
| `stop_server` | SIGTERM then SIGKILL after a grace period. Only for servers bellows started. | `port` |
| `smoke_test` | Sends N chat prompts over the OpenAI-compatible API, reports responses, latency, tokens/second. | `port`, `prompts?`, `maxTokens?`, `timeoutMs?` |
| `eval_history` | Read-only crucible queries: list runs, per-category run summary (pass rates plus complied/hedged/refused tallies), or compare two runs. | `action`, `model?`, `runId?`, `runA?`, `runB?` |

Resources: `bellows://models` (the models list as JSON) and `bellows://eval-runs` (all eval runs as JSON).

## Setup

Requires Node 24+ (for built-in `node:sqlite`) and a built llama.cpp checkout.

```bash
npm install
npm run build
```

Configuration is three environment variables:

```bash
BELLOWS_MODELS_DIR=/path/to/models          # scanned recursively for .gguf
BELLOWS_LLAMA_SERVER=/path/to/llama-server  # the binary bellows spawns
BELLOWS_CRUCIBLE_DB=/path/to/results.db     # crucible eval db, opened read-only
```

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "bellows": {
      "command": "node",
      "args": ["/absolute/path/to/bellows/dist/index.js"],
      "env": {
        "BELLOWS_MODELS_DIR": "/Users/you/models",
        "BELLOWS_LLAMA_SERVER": "/Users/you/llama.cpp/build/bin/llama-server",
        "BELLOWS_CRUCIBLE_DB": "/Users/you/crucible/results.db"
      }
    }
  }
}
```

For Claude Code this goes in `.mcp.json` (project) or via `claude mcp add`; for Claude Desktop it goes in `claude_desktop_config.json`.

### HTTP transport

```bash
node dist/index.js --http --port 8765
```

This exposes a stateless streamable-HTTP endpoint at `POST http://127.0.0.1:8765/mcp` for clients that prefer HTTP over stdio.
`--host` changes the bind address (default `127.0.0.1`); containers need `--host 0.0.0.0` for published ports to work.

### Docker

```bash
docker build -t bellows .
docker run --rm -p 8765:8765 \
  -v /path/to/models:/models -e BELLOWS_MODELS_DIR=/models \
  -v /path/to/results.db:/crucible/results.db:ro -e BELLOWS_CRUCIBLE_DB=/crucible/results.db \
  bellows
```

The image is multi-stage (`node:24-slim`, dev dependencies pruned), runs as the non-root `node` user, serves the HTTP transport on 0.0.0.0:8765, and has a container healthcheck that sends a real JSON-RPC `initialize` to `/mcp`.
`start_server` is not useful inside the container unless you also bake in a llama-server binary and set `BELLOWS_LLAMA_SERVER`; the image is primarily for the scan/status/eval-history surface over HTTP.

## Technical decisions

**Transport: stdio primary, streamable HTTP opt-in.**
stdio is what Claude Code and Claude Desktop spawn natively, and it inherits the parent lifecycle, so servers bellows started die with the session instead of leaking.
The HTTP transport is stateless (a fresh MCP server per request) but every request shares the one `Supervisor` instance, so process ownership survives across calls.
Only POST is accepted; there is no session or SSE state to manage, which keeps the surface small.

**Process ownership model.**
Bellows will only ever signal a `ChildProcess` handle it created itself.
`stop_server` looks the port up in its own supervision table and errors if it is not there; there is no "kill whatever is on port X" path by design.
Conversely `start_server` does a TCP probe first and refuses to bind a port where anything is already listening, so it can never fight another process for a port.
Stop is graceful: SIGTERM, then SIGKILL only after a 10 s grace period.
Bellows reaps all children before exiting, whether it receives `SIGINT`/`SIGTERM` or the MCP client simply closes stdin.

**Why node:sqlite.**
The eval database is read-only from bellows' perspective, and Node 24 ships a synchronous SQLite driver in core.
That removes a native-module dependency (better-sqlite3) and its rebuild churn for zero functional cost.
The database is opened with `readOnly: true`, so bellows physically cannot write to crucible's data.

**No shell, everywhere.**
`llama-server` is spawned via `spawn(bin, argsArray)`; no string ever passes through a shell, so model paths with spaces or metacharacters are inert.
All network calls (`/health`, `/props`, chat completions) carry `AbortSignal.timeout` deadlines.
All tool inputs are zod-validated with ranges (ports 1024-65535 for binding, ctx up to 1M, at most 20 smoke prompts), and every failure path returns a message that says what to do next.

## Testing

```bash
npm test              # everything
npm run test:unit     # scanning, DB queries, arg building, MCP schema surface
npm run test:integration  # real llama-server lifecycle (skips if binary/model missing)
```

Unit tests cover the quant/shard scanner against a synthetic directory tree, the crucible queries against the real `results.db` (read-only), argv construction, supervisor ownership refusals, and the full MCP tool/resource surface over an in-memory transport.
The integration test starts the real LFM2.5-1.2B Q4_K_M model on port 8091 through the actual MCP tool calls, verifies a duplicate start is refused, smoke-tests it, stops it, and asserts the port is dead afterwards.
It skips with a message when the llama-server binary, the models directory, or the model is absent.

Current results on the development machine (Apple M4 Pro, 24 GB, 2026-07-07): 26 unit tests pass, 1 integration test passes, 0 failures.
In GitHub CI only the 26 unit tests exercise code; the integration test self-skips because the runner has no llama-server binary or model.
CI also builds the Docker image on every push.

## Demo transcript

Real tool calls against this machine, unedited except for trimming long model lists.

`list_models {}` found 6 models:

```json
{
  "dir": "~/inf-eng/models",
  "count": 6,
  "models": [
    {
      "name": "LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M",
      "path": "~/inf-eng/models/LFM2.5-1.2B-Instruct-Uncensored-GGUF/LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M.gguf",
      "sizeBytes": 730895520,
      "sizeHuman": "697.0 MiB",
      "quant": "Q4_K_M",
      "sharded": false
    },
    {
      "name": "gemma-4-12b-it-uncensored-Q4_K_M",
      "path": "~/inf-eng/models/gemma-4-12b-it-uncensored-Q4_K_M.gguf",
      "sizeBytes": 7381381760,
      "sizeHuman": "6.87 GiB",
      "quant": "Q4_K_M",
      "sharded": false
    }
  ]
}
```

`start_server {"model": "LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M", "port": 8091, "ctx": 2048}`:

```json
{
  "pid": 64539,
  "port": 8091,
  "modelPath": "~/inf-eng/models/LFM2.5-1.2B-Instruct-Uncensored-GGUF/LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M.gguf",
  "startedAt": "2026-07-07T20:29:22.805Z",
  "apiBase": "http://127.0.0.1:8091/v1"
}
```

A second `start_server` on the same port was refused with an error naming the existing pid and model.

`server_status {"port": 8091}`:

```json
{
  "ownedServers": [
    {
      "pid": 64539,
      "port": 8091,
      "modelPath": ".../LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M.gguf",
      "startedAt": "2026-07-07T20:29:22.805Z",
      "uptimeSeconds": 1,
      "alive": true,
      "healthy": true
    }
  ],
  "probe": { "port": 8091, "healthy": true, "ownedByBellows": true, "model": ".../LFM2.5-1.2B-Instruct-Uncensored-Q4_K_M.gguf" }
}
```

`smoke_test {"port": 8091}`:

```json
{
  "port": 8091,
  "prompts": 3,
  "results": [
    { "prompt": "Reply with exactly one word: pong", "response": "pong", "latencyMs": 59, "completionTokens": 3, "tokPerSec": 320.7 },
    { "prompt": "What is 17 * 23? Answer with just the number.", "response": "391", "latencyMs": 40, "completionTokens": 2, "tokPerSec": 395.7 },
    { "prompt": "Name the capital of France in one word.", "response": "Paris", "latencyMs": 41, "completionTokens": 2, "tokPerSec": 373.4 }
  ],
  "meanLatencyMs": 47,
  "meanTokPerSec": 363.3
}
```

`stop_server {"port": 8091}`:

```json
{ "port": 8091, "pid": 64539, "exitCode": 0, "forced": false }
```

`eval_history {"action": "compare_runs", "runA": 23, "runB": 24}` (base vs abliterated LFM2.5 Q4_K_M, falsereject category excerpt):

```json
{
  "category": "falsereject",
  "a": { "n": 50, "complied": 7, "hedged": 43, "refused": 0 },
  "b": { "n": 50, "complied": 39, "hedged": 11, "refused": 0 }
}
```

### Measured numbers and their caveats

- Model count on this machine: 6 runnable GGUFs (mmproj files correctly excluded).
- The full start -> status -> smoke -> stop lifecycle for LFM2.5-1.2B Q4_K_M (697 MiB) completed in 716 ms in the integration test, including model load to first healthy `/health` response. The model file was warm in the page cache; a cold start would be slower and was not measured.
- Smoke-test mean latency was 47 ms per request, but those completions are only 2-3 tokens long.
- The tokens/second figures (320-396) come from llama.cpp's own `timings.predicted_per_second` over those tiny generations and overstate sustained throughput. Crucible's eval history for the same model reports roughly 60 tok/s sustained over full-length responses, which is the honest number for real workloads.
- The HTTP transport was verified with raw JSON-RPC `initialize` and `tools/list` requests via curl; no latency measurement was taken for it.

## Limitations

There are no retries or circuit breakers.
Every call targets a localhost child process, so failures are surfaced to the agent verbatim (with the llama-server stderr tail attached) rather than masked by retry loops; the agent is the retry policy.
There is no tracing or metrics endpoint.
Observability is the structured JSON each tool returns plus the per-process stderr tails; if bellows grew beyond one host, an OTel span per tool call would be the first addition.
The HTTP transport has no authentication.
It binds `127.0.0.1` by default and is meant for local or trusted-network use; do not publish the port beyond that.
Supervision state is in-memory only.
Graceful shutdown (SIGINT, SIGTERM, or the MCP client closing stdin) reaps all children, but a SIGKILL of the bellows process orphans any running llama-servers, and a restarted bellows will refuse their ports rather than adopt them.
`eval_history` is read-only against crucible's schema and will break if that schema changes; it is pinned by the integration between the two repos, not by a versioned contract.
