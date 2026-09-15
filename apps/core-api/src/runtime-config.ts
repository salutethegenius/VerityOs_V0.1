export const PROFILES = ["development", "demo", "sovereign"] as const;
export type VerityProfile = (typeof PROFILES)[number];

export const DEFAULT_SESSION_SECRET = "dev-only-change-me-in-production-32b";
export const PHASE = "11";

export class ConfigError extends Error {
  readonly code = "INVALID_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type EnvSource = Record<string, string | undefined>;

export function resolveProfile(env: EnvSource = process.env): VerityProfile {
  const raw = (env.VERITY_PROFILE ?? env.VERITY_DEPLOYMENT_PROFILE ?? "development").trim().toLowerCase();
  if (!(PROFILES as readonly string[]).includes(raw)) {
    throw new ConfigError(`invalid VERITY_PROFILE '${raw}' (expected development|demo|sovereign)`);
  }
  return raw as VerityProfile;
}

function requireUrl(name: string, value: string | undefined, required: boolean): string | undefined {
  if (!value || !value.trim()) {
    if (required) {
      throw new ConfigError(`${name} is required`);
    }
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith("http") && name !== "DATABASE_URL") {
      throw new Error("not http");
    }
  } catch {
    if (name === "DATABASE_URL") {
      if (!/^postgres(ql)?:\/\//.test(value)) {
        throw new ConfigError(`${name} must be a postgres URL`);
      }
      return value;
    }
    throw new ConfigError(`${name} must be a valid URL`);
  }
  return value;
}

export function loadConfig(env: EnvSource = process.env) {
  const profile = resolveProfile(env);
  const isDev = profile === "development";
  const databaseUrl = env.DATABASE_URL ?? (isDev ? "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit" : undefined);
  if (!databaseUrl) {
    throw new ConfigError("DATABASE_URL is required");
  }
  requireUrl("DATABASE_URL", databaseUrl, true);

  const corsOrigin = env.CORS_ORIGIN ?? (isDev ? "http://127.0.0.1:3000" : undefined);
  if (!corsOrigin) {
    throw new ConfigError("CORS_ORIGIN is required");
  }
  for (const origin of corsOrigin.split(",").map((s) => s.trim()).filter(Boolean)) {
    requireUrl("CORS_ORIGIN", origin, true);
  }

  const sessionSecret = env.SESSION_SECRET ?? (isDev ? DEFAULT_SESSION_SECRET : undefined);
  if (!sessionSecret) {
    throw new ConfigError("SESSION_SECRET is required");
  }
  if (!isDev && (sessionSecret.length < 32 || sessionSecret === DEFAULT_SESSION_SECRET)) {
    throw new ConfigError("SESSION_SECRET must be at least 32 characters and not the development default");
  }

  const httpsOrigins = corsOrigin.split(",").some((o) => o.trim().startsWith("https://"));
  const cookieSecure = env.COOKIE_SECURE === "true" || (!isDev && httpsOrigins);
  if (!isDev && httpsOrigins && env.COOKIE_SECURE === "false") {
    throw new ConfigError("COOKIE_SECURE cannot be false when CORS_ORIGIN uses HTTPS");
  }

  const embedding = env.VERITY_EMBEDDING_PROVIDER ?? (isDev ? "mock" : undefined);
  if (!embedding) {
    throw new ConfigError("VERITY_EMBEDDING_PROVIDER is required (mock is not implied outside development)");
  }
  if (embedding === "mock" && profile === "sovereign" && env.VERITY_ALLOW_MOCK !== "1") {
    throw new ConfigError("sovereign profile forbids mock embeddings unless VERITY_ALLOW_MOCK=1 is set explicitly");
  }
  if (embedding === "mock" && profile === "demo" && !env.VERITY_EMBEDDING_PROVIDER) {
    throw new ConfigError("demo profile requires an explicit VERITY_EMBEDDING_PROVIDER");
  }

  const dimensions = env.VERITY_EMBEDDING_DIMENSIONS;
  if (dimensions && Number(dimensions) !== 768) {
    throw new ConfigError("VERITY_EMBEDDING_DIMENSIONS must be 768 for V0.1");
  }

  const dataDir = env.VERITY_DATA_DIR ?? (isDev ? "./data" : undefined);
  if (!dataDir) {
    throw new ConfigError("VERITY_DATA_DIR is required");
  }

  const novaUrl = env.NOVA_INTERNAL_URL;
  if (novaUrl) {
    requireUrl("NOVA_INTERNAL_URL", novaUrl, true);
  }
  const corePublic = env.CORE_API_URL;
  if (corePublic) {
    requireUrl("CORE_API_URL", corePublic, true);
  }

  return {
    profile,
    databaseUrl,
    corsOrigin,
    cookieSecure,
    trustProxy: env.TRUST_PROXY === "true",
    sessionSecret,
    openaiKey: env.OPENAI_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    compatibleKey: env.OPENAI_COMPATIBLE_API_KEY,
    embeddingProvider: embedding,
    dataDir,
    phase: PHASE,
  };
}

export function assertStartupConfig(env: EnvSource = process.env) {
  return loadConfig(env);
}

export const DEMO_ORG_NAME = "VerityOS Government Communications Demo";

export function assertDemoResetAllowed(env: EnvSource = process.env): void {
  const profile = resolveProfile(env);
  if (profile !== "demo" && profile !== "development") {
    throw new ConfigError("demo reset refused: VERITY_PROFILE must be demo or development");
  }
  if (env.VERITY_DEMO_RESET !== "1") {
    throw new ConfigError("demo reset refused: set VERITY_DEMO_RESET=1");
  }
}
