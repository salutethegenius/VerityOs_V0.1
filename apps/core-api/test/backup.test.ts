import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { TEST_DATABASE_URL } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("backup manifest", () => {
  it("writes SHA-256 hashes that match the dump files", () => {
    const dest = mkdtempSync(join(tmpdir(), "verity-backup-"));
    const result = spawnSync("bash", [join(ROOT, "scripts/backup.sh"), dest], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        VERITY_DATA_DIR: process.env.VERITY_DATA_DIR ?? "/tmp/verity-data",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const dir = result.stdout.trim().split("\n").at(-1);
    expect(dir).toBeTruthy();
    const manifest = JSON.parse(readFileSync(join(dir!, "manifest.json"), "utf8"));
    expect(manifest.not_audit_evidence).toBe(true);
    expect(manifest.kind).toBe("operational_backup");
    const db = readFileSync(join(dir!, manifest.database_file));
    const files = readFileSync(join(dir!, manifest.files_archive));
    expect(createHash("sha256").update(db).digest("hex")).toBe(manifest.database_sha256);
    expect(createHash("sha256").update(files).digest("hex")).toBe(manifest.files_sha256);
    rmSync(dest, { recursive: true, force: true });
  });
});
