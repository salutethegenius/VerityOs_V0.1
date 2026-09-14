import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY_RULES } from "../src/index.js";

describe("default policy rules", () => {
  it("keeps confidential and restricted data on-device", () => {
    expect(DEFAULT_POLICY_RULES.leave_device.public).toBe(true);
    expect(DEFAULT_POLICY_RULES.leave_device.confidential).toBe(false);
    expect(DEFAULT_POLICY_RULES.cloud_models.restricted).toBe(false);
  });
});
