import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Nova fixtures (Phase 0)", () => {
  it("captures brand plug-in shape without a production brand name in core paths", () => {
    const config = JSON.parse(
      readFileSync(join(root, "tests/fixtures/nova/brand-config.json"), "utf8")
    ) as { brand_id: string; platforms: string[] };
    expect(config.brand_id).toBe("fixture_credit_union");
    expect(config.platforms).toContain("facebook");
  });

  it("records Slack HMAC replay rules", () => {
    const slack = JSON.parse(
      readFileSync(join(root, "tests/fixtures/nova/slack-signing.json"), "utf8")
    ) as { replay_tolerance_seconds: number; algorithm: string };
    expect(slack.replay_tolerance_seconds).toBe(300);
    expect(slack.algorithm).toBe("HMAC-SHA256");
  });
});
