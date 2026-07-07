import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface ModelEntry {
  name: string;
  path: string;
  sizeBytes: number;
  sizeHuman: string;
  quant: string | null;
  sharded: boolean;
  shardCount?: number;
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
// Matches llama.cpp quant type names embedded in filenames: Q4_K_M, Q8_0, IQ4_XS, Q6_K, F16, BF16, ...
const QUANT_RE = /(?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32/gi;

export function guessQuant(filename: string): string | null {
  const base = path.basename(filename).replace(/\.gguf$/i, "");
  const matches = base.toUpperCase().match(QUANT_RE);
  // The quant label conventionally comes last in the filename, so the last match wins.
  return matches ? (matches[matches.length - 1] ?? null) : null;
}

export function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  return `${bytes} B`;
}

export async function scanModels(dir: string): Promise<ModelEntry[]> {
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Models directory not found or not a directory: ${dir}`);
  }

  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const ggufFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".gguf")) continue;
    // mmproj files are multimodal projectors, not runnable language models.
    if (entry.name.toLowerCase().startsWith("mmproj")) continue;
    ggufFiles.push(path.join(entry.parentPath, entry.name));
  }

  const singles: string[] = [];
  const shardSets = new Map<string, { paths: string[]; declared: number }>();
  for (const file of ggufFiles) {
    const m = path.basename(file).match(SHARD_RE);
    if (!m) {
      singles.push(file);
      continue;
    }
    const key = path.join(path.dirname(file), m[1]!);
    const set = shardSets.get(key) ?? { paths: [], declared: Number(m[3]) };
    set.paths.push(file);
    shardSets.set(key, set);
  }

  const models: ModelEntry[] = [];
  for (const file of singles) {
    const s = await stat(file);
    models.push({
      name: path.basename(file, ".gguf"),
      path: file,
      sizeBytes: s.size,
      sizeHuman: humanSize(s.size),
      quant: guessQuant(file),
      sharded: false,
    });
  }
  for (const [key, set] of shardSets) {
    set.paths.sort();
    let total = 0;
    for (const p of set.paths) total += (await stat(p)).size;
    models.push({
      name: path.basename(key),
      // llama.cpp loads a sharded set from its first shard.
      path: set.paths[0]!,
      sizeBytes: total,
      sizeHuman: humanSize(total),
      quant: guessQuant(key),
      sharded: true,
      shardCount: set.declared,
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}
