export interface SmokeResult {
  prompt: string;
  response: string;
  latencyMs: number;
  completionTokens: number | null;
  tokPerSec: number | null;
}

export interface SmokeSummary {
  port: number;
  prompts: number;
  results: SmokeResult[];
  meanLatencyMs: number;
  meanTokPerSec: number | null;
}

export const DEFAULT_SMOKE_PROMPTS = [
  "Reply with exactly one word: pong",
  "What is 17 * 23? Answer with just the number.",
  "Name the capital of France in one word.",
];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { completion_tokens?: number };
  timings?: { predicted_per_second?: number };
}

export async function smokeTest(opts: {
  port: number;
  prompts: string[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<SmokeSummary> {
  const url = `http://127.0.0.1:${opts.port}/v1/chat/completions`;
  const results: SmokeResult[] = [];

  for (const prompt of opts.prompts) {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          max_tokens: opts.maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `Chat request to port ${opts.port} failed (${err instanceof Error ? err.message : String(err)}). Is a llama-server running there? Check with server_status.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Chat request failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const latencyMs = Math.round(performance.now() - started);
    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    const completionTokens = json.usage?.completion_tokens ?? null;
    // llama.cpp reports its own generation speed; prefer that over a wall-clock estimate
    // because wall clock includes prompt processing.
    const tokPerSec =
      json.timings?.predicted_per_second ??
      (completionTokens !== null && latencyMs > 0 ? (completionTokens / latencyMs) * 1000 : null);

    results.push({
      prompt,
      response: content,
      latencyMs,
      completionTokens,
      tokPerSec: tokPerSec !== null ? Math.round(tokPerSec * 10) / 10 : null,
    });
  }

  const meanLatencyMs = Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length);
  const speeds = results.filter((r) => r.tokPerSec !== null).map((r) => r.tokPerSec!);
  const meanTokPerSec = speeds.length
    ? Math.round((speeds.reduce((a, s) => a + s, 0) / speeds.length) * 10) / 10
    : null;

  return { port: opts.port, prompts: results.length, results, meanLatencyMs, meanTokPerSec };
}
