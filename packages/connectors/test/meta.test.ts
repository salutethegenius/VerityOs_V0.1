import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry, MetaFacebookConnector, sha256Hex } from "../src/index.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("connector registry and Meta adapter", () => {
  it("hashes UTF-8 artifact bytes exactly", () => {
    expect(sha256Hex("café")).toBe(sha256("café"));
    expect(sha256Hex("café")).not.toBe(sha256Hex("cafe"));
    expect(sha256Hex("Exact approved Facebook draft")).toBe(sha256("Exact approved Facebook draft"));
  });

  it("resolves implementations by connector_type", () => {
    const registry = new ConnectorRegistry();
    registry.register(new MetaFacebookConnector());
    expect(registry.resolve("meta.facebook").type).toBe("meta.facebook");
    expect(registry.listTypes()).toEqual(["meta.facebook"]);
  });

  it("publishes and schedules through mocked HTTP without returning secrets", async () => {
    const seen: { url: string; body: string }[] = [];
    const connector = new MetaFacebookConnector({
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), body: String(init?.body ?? "") });
        if (String(init?.method ?? "GET").toUpperCase() === "GET") {
          return new Response(JSON.stringify({ name: "Acme Page" }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "123_456" }), { status: 200 });
      },
    });
    const healthy = await connector.health({
      connectorId: "c1",
      pageId: "page-1",
      secret: "super-secret-token",
    });
    expect(healthy.ok).toBe(true);
    expect(healthy.page_name).toBe("Acme Page");
    expect(JSON.stringify(healthy)).not.toContain("super-secret-token");
    const published = await connector.execute({
      connectorId: "c1",
      connectorType: "meta.facebook",
      action: "publish_post",
      artifactHash: sha256("hello world"),
      payload: { message: "hello world" },
      secret: "super-secret-token",
      pageId: "page-1",
    });
    expect(published.external_action_id).toBe("123_456");
    expect(published.status).toBe("ok");
    expect(JSON.stringify(published)).not.toContain("super-secret-token");
    expect(seen.some((row) => row.body.includes("hello world"))).toBe(true);

    const scheduledFor = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const scheduled = await connector.execute({
      connectorId: "c1",
      connectorType: "meta.facebook",
      action: "schedule_post",
      artifactHash: sha256("hello world"),
      payload: { message: "hello world", scheduled_for: scheduledFor },
      secret: "super-secret-token",
      pageId: "page-1",
      scheduledFor,
    });
    expect(scheduled.external_action_id).toBe("123_456");
    expect(seen.some((row) => row.body.includes("SCHEDULED"))).toBe(true);
  });

  it("maps auth failure, rejection, and timeout to connector errors", async () => {
    const auth = new MetaFacebookConnector({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "auth" } }), { status: 401 }),
    });
    await expect(
      auth.execute({
        connectorId: "c1",
        connectorType: "meta.facebook",
        action: "publish_post",
        artifactHash: sha256Hex("x"),
        payload: { message: "x" },
        secret: "tok",
        pageId: "p",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED", ambiguous: false });

    const rejected = new MetaFacebookConnector({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
    });
    await expect(
      rejected.execute({
        connectorId: "c1",
        connectorType: "meta.facebook",
        action: "publish_post",
        artifactHash: sha256Hex("x"),
        payload: { message: "x" },
        secret: "tok",
        pageId: "p",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_REJECTED", ambiguous: false });

    const timeout = new MetaFacebookConnector({
      timeoutMs: 10,
      fetchImpl: async (_url, init) => {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return new Response("{}");
      },
    });
    await expect(
      timeout.execute({
        connectorId: "c1",
        connectorType: "meta.facebook",
        action: "publish_post",
        artifactHash: sha256Hex("x"),
        payload: { message: "x" },
        secret: "tok",
        pageId: "p",
      })
    ).rejects.toMatchObject({ code: "AMBIGUOUS_PROVIDER_OUTCOME", ambiguous: true });
  });
});
