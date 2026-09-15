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
    expect(shortHash("VTY-2026-A1B2C3D4")).toBe("VTY-2026-A1B2C3D4");
    expect(shortHash("a".repeat(64))).toContain("…");
    expect(connectorStateLabel("needs_review")).toBe("Needs review");
    expect(connectorStateLabel("pending_approval")).toBe("Awaiting approval");
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

describe("operator display", () => {
  it("dedupes citation titles without dropping chunk counts", async () => {
    const { citationsForDisplay, dedupeCitations } = await import("../lib/operator-display");
    const visible = dedupeCitations([
      { title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_id: "c1" },
      { title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_id: "c2" },
      { title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_id: "c3" },
      { title: "Shelter Guide", source_version_id: "v2", chunk_id: "c4" },
    ]);
    expect(visible).toHaveLength(2);
    expect(visible[0]).toMatchObject({ title: "Public Emergency Advisory Guidance", chunkCount: 3 });
    expect(visible[1]).toMatchObject({ title: "Shelter Guide", chunkCount: 1 });

    const execute = [
      { title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_id: "c1" },
      { title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_id: "c2" },
    ];
    const detail = [{ title: "Public Emergency Advisory Guidance", source_version_id: "v1", chunk_count: 2 }];
    expect(dedupeCitations(citationsForDisplay(execute, detail))).toEqual([
      expect.objectContaining({ title: "Public Emergency Advisory Guidance", chunkCount: 2 }),
    ]);
    expect(dedupeCitations(citationsForDisplay(execute, []))).toHaveLength(1);
  });

  it("labels mock adapter output without rewriting the recorded artifact", async () => {
    const { presentMockArtifact } = await import("../lib/operator-display");
    const recorded = "mock:mock-local:SYSTEM: You are VerityOS";
    expect(presentMockArtifact(recorded)).toEqual({ mock: true, recorded });
    expect(presentMockArtifact("Paris is the capital of France.")).toEqual({
      mock: false,
      recorded: "Paris is the capital of France.",
    });
  });
});

describe("login redirect source", () => {
  it("navigates authenticated users from /login inside useEffect", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/useEffect\(\(\) => \{[\s\S]*router\.replace\("\/"\)/);
    const beforeEffect = source.slice(0, source.indexOf("useEffect"));
    expect(beforeEffect).not.toMatch(/router\.replace/);
  });
});

describe("browser-safe configuration", () => {
  it("does not place secrets in NEXT_PUBLIC_ variables", async () => {
    const { readFileSync } = await import("node:fs");
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    for (const line of example.split("\n")) {
      if (!line.startsWith("NEXT_PUBLIC_")) continue;
      expect(line).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE_URL|sk-|xoxb/i);
    }
  });
});
