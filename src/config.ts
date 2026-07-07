export interface BellowsConfig {
  modelsDir: string | undefined;
  llamaServerBin: string | undefined;
  crucibleDb: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BellowsConfig {
  return {
    modelsDir: env.BELLOWS_MODELS_DIR,
    llamaServerBin: env.BELLOWS_LLAMA_SERVER,
    crucibleDb: env.BELLOWS_CRUCIBLE_DB,
  };
}

export function requireSetting(value: string | undefined, envVar: string, what: string): string {
  if (!value) {
    throw new Error(
      `No ${what} configured. Set the ${envVar} environment variable or pass it explicitly in the tool call.`,
    );
  }
  return value;
}
