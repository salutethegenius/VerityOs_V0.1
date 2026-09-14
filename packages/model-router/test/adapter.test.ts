import { describe, expect, it } from "vitest";
import { MockAdapter, OpenAICompatibleAdapter } from "../src/index.js";

describe("provider adapter contract", () => {
  it("mock adapter returns observable text without chain-of-thought", async () => {
    const adapter = new MockAdapter();
    const result = await adapter.complete({
      model: {
        id: "m",
        organization_id: "o",
        model_key: "mock-local",
        provider: "mock",
        deployment_type: "local",
        endpoint: null,
        capabilities_json: ["chat"],
        allowed_data_classes_json: ["public"],
        risk_ceiling: "low",
        requires_internet: false,
        enabled: true,
      },
      prompt: "hello",
      executionId: "e",
    });
    expect(result.provider).toBe("mock");
    expect(result.text.startsWith("mock:mock-local:")).toBe(true);
  });

  it("openai-compatible adapter requires an endpoint", async () => {
    const adapter = new OpenAICompatibleAdapter();
    await expect(
      adapter.complete({
        model: {
          id: "m",
          organization_id: "o",
          model_key: "llama",
          provider: "openai-compatible",
          deployment_type: "local",
          endpoint: null,
          capabilities_json: ["chat"],
          allowed_data_classes_json: ["public"],
          risk_ceiling: "low",
          requires_internet: false,
          enabled: true,
        },
        prompt: "hello",
        executionId: "e",
      })
    ).rejects.toThrow(/endpoint/);
  });
});
