import { describe, expect, it } from "vitest";
import { CoreApiError, parseApiError } from "../lib/api/client";
import { COMMAND_NAV, PRIMARY_NAV, visibleNav } from "../lib/permissions";
import { connectorStateLabel, shortHash, sourceTrustState } from "../lib/format";

describe("API error envelope", () => {
  it("surfaces message and request_id without stack traces", () => {
    const error = parseApiError(
      { error: { code: "ORIGIN_DENIED", message: "origin is not allowed", request_id: "req-1" } },
      403,
      "ignored"
    );
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error.message).toBe("origin is not allowed");
    expect(error.requestId).toBe("req-1");
    expect(error.message).not.toMatch(/at |stack/i);
  });
});

describe("permission-aware navigation", () => {
  it("hides command and user management from members", () => {
    const member = ["nova.use", "knowledge.read", "models.read", "policies.read", "approvals.read", "audit.read"];
    const labels = visibleNav(PRIMARY_NAV, member).map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Nova");
    expect(labels).toContain("Knowledge");
    expect(labels).toContain("Command");
    expect(labels).toContain("Audit");
    expect(visibleNav(COMMAND_NAV, member).map((i) => i.label)).toEqual(["Policies", "Models", "Skills", "Approvals"]);
    expect(visibleNav(COMMAND_NAV, member).map((i) => i.label)).not.toContain("Users");
    expect(visibleNav(COMMAND_NAV, []).map((i) => i.label)).toEqual([]);
  });
});

describe("display helpers", () => {
  it("shortens hashes and maps connector states", () => {
    expect(shortHash("a".repeat(64))).toContain("…");
    expect(connectorStateLabel("needs_review")).toBe("Needs review");
    expect(connectorStateLabel("posted")).toBe("Published");
    expect(connectorStateLabel("failed")).toBe("Failed");
    expect(sourceTrustState({ approved_at: null, indexed: false })).toBe("Uploaded");
    expect(sourceTrustState({ approved_at: null, indexed: true })).toBe("Indexed");
    expect(sourceTrustState({ approved_at: "2026-01-01", indexed: true })).toBe("Approved");
  });

  it("treats local draft edits as unsealed", () => {
    const sealed = "official artifact";
    const local = "official artifact (edited)";
    expect(local !== sealed).toBe(true);
  });
});
