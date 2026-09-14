import Fastify from "fastify";

/**
 * Core API is a health stub in Phase 0–2.
 * Kernel verification is exercised through the library and CLI, not this process.
 */
export async function buildServer() {
  const app = Fastify({ logger: false });
  app.get("/v1/health", async () => ({
    status: "ok",
    component: "core-api",
    phase: "0-2-stub",
  }));
  return app;
}
