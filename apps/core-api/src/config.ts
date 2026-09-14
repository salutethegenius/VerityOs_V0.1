export function loadConfig() {
  const corsOrigin = process.env.CORS_ORIGIN ?? "http://127.0.0.1:3000";
  return {
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
    corsOrigin,
    cookieSecure: process.env.COOKIE_SECURE === "true",
    trustProxy: process.env.TRUST_PROXY === "true",
    sessionSecret: process.env.SESSION_SECRET ?? "dev-only-change-me-in-production-32b",
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    compatibleKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  };
}
