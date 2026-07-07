import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import net from "node:net";

export interface StartOptions {
  modelPath: string;
  port: number;
  ngl: number;
  ctx: number;
  readyTimeoutMs: number;
}

export interface ManagedServer {
  pid: number;
  port: number;
  modelPath: string;
  startedAt: string;
}

interface ManagedInternal extends ManagedServer {
  child: ChildProcess;
  stderrTail: string[];
  exited: boolean;
  exitCode: number | null;
}

export function buildServerArgs(opts: Pick<StartOptions, "modelPath" | "port" | "ngl" | "ctx">): string[] {
  return [
    "-m", opts.modelPath,
    "--port", String(opts.port),
    "--host", "127.0.0.1",
    "-ngl", String(opts.ngl),
    "--ctx-size", String(opts.ctx),
    "--flash-attn", "auto",
    "--jinja",
  ];
}

export async function probeHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchServerProps(
  port: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/props`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPortInUse(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const STDERR_TAIL_LINES = 40;

export class Supervisor {
  private servers = new Map<number, ManagedInternal>();
  private llamaServerBin: string;

  constructor(llamaServerBin: string) {
    this.llamaServerBin = llamaServerBin;
  }

  list(): Array<ManagedServer & { uptimeSeconds: number; alive: boolean }> {
    return [...this.servers.values()].map((s) => ({
      pid: s.pid,
      port: s.port,
      modelPath: s.modelPath,
      startedAt: s.startedAt,
      uptimeSeconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000),
      alive: !s.exited,
    }));
  }

  owns(port: number): boolean {
    const s = this.servers.get(port);
    return s !== undefined && !s.exited;
  }

  async start(opts: StartOptions): Promise<ManagedServer> {
    const existing = this.servers.get(opts.port);
    if (existing && !existing.exited) {
      throw new Error(
        `Bellows already runs a server on port ${opts.port} (pid ${existing.pid}, model ${existing.modelPath}). Stop it first with stop_server.`,
      );
    }

    const modelStat = await stat(opts.modelPath).catch(() => null);
    if (!modelStat?.isFile()) {
      throw new Error(`Model file not found: ${opts.modelPath}`);
    }
    const binStat = await stat(this.llamaServerBin).catch(() => null);
    if (!binStat?.isFile()) {
      throw new Error(`llama-server binary not found: ${this.llamaServerBin}`);
    }

    if (await isPortInUse(opts.port)) {
      throw new Error(
        `Port ${opts.port} is already in use by a process bellows does not own. Refusing to start. Pick another port or stop that process yourself.`,
      );
    }

    const args = buildServerArgs(opts);
    const child = spawn(this.llamaServerBin, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const managed: ManagedInternal = {
      pid: child.pid ?? -1,
      port: opts.port,
      modelPath: opts.modelPath,
      startedAt: new Date().toISOString(),
      child,
      stderrTail: [],
      exited: false,
      exitCode: null,
    };

    // Async spawn failures (e.g. EACCES) emit "error" with no "exit". This must be
    // attached before any await or throw: a single unhandled "error" event would
    // crash the whole MCP server, and the ready loop would otherwise spin blind.
    child.on("error", (err) => {
      if (!managed.exited) {
        managed.exited = true;
        managed.stderrTail.push(`spawn error: ${err.message}`);
      }
    });
    child.on("exit", (code) => {
      managed.exited = true;
      managed.exitCode = code;
    });

    if (child.pid === undefined) {
      throw new Error("llama-server failed to spawn (no pid).");
    }

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        managed.stderrTail.push(line);
        if (managed.stderrTail.length > STDERR_TAIL_LINES) managed.stderrTail.shift();
      }
    });

    this.servers.set(opts.port, managed);

    const deadline = Date.now() + opts.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (managed.exited) {
        this.servers.delete(opts.port);
        throw new Error(
          `llama-server exited with code ${managed.exitCode} before becoming healthy.\nLast stderr:\n${managed.stderrTail.join("\n")}`,
        );
      }
      if (await probeHealth(opts.port)) {
        return {
          pid: managed.pid,
          port: managed.port,
          modelPath: managed.modelPath,
          startedAt: managed.startedAt,
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    child.kill("SIGKILL");
    this.servers.delete(opts.port);
    throw new Error(
      `llama-server did not become healthy within ${opts.readyTimeoutMs}ms; killed pid ${managed.pid}.\nLast stderr:\n${managed.stderrTail.join("\n")}`,
    );
  }

  async stop(port: number, gracePeriodMs = 10_000): Promise<{ pid: number; exitCode: number | null; forced: boolean }> {
    const managed = this.servers.get(port);
    if (!managed) {
      throw new Error(
        `No bellows-owned server on port ${port}. Bellows only stops processes it started; it will not kill anything else.`,
      );
    }
    if (managed.exited) {
      this.servers.delete(port);
      return { pid: managed.pid, exitCode: managed.exitCode, forced: false };
    }

    const exited = new Promise<void>((resolve) => {
      managed.child.once("exit", () => resolve());
    });
    managed.child.kill("SIGTERM");
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      managed.child.kill("SIGKILL");
    }, gracePeriodMs);
    await exited;
    clearTimeout(timer);
    this.servers.delete(port);
    return { pid: managed.pid, exitCode: managed.exitCode, forced };
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((port) => this.stop(port, 3000)));
  }
}
