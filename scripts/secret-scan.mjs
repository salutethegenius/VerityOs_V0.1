#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "tmp",
  "backups",
  "playwright-report",
  "test-results",
  ".pnpm-store",
]);

const FIXTURE = "tests/security/secret-scan-fixture.txt";

const PATTERNS = [
  { name: "slack-bot", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "anthropic", re: /sk-ant-api03-[A-Za-z0-9_-]{20,}/ },
  { name: "openai", re: /sk-(?:live|proj)-[A-Za-z0-9]{20,}/ },
  { name: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "meta-token", re: /EAA[A-Za-z0-9]{30,}/ },
];

const ALLOW_PATHS = [
  FIXTURE,
  ".env.example",
  "docs/",
  "CHANGELOG.md",
  "apps/core-api/src/seed-dev.ts",
  "apps/core-api/src/seed-demo.ts",
  "apps/core-api/test/",
  "scripts/secret-scan.mjs",
];

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".pnpm")) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    const st = statSync(full);
    if (st.isDirectory()) {
      listFiles(full, out);
    } else if (st.isFile() && st.size < 1_000_000) {
      out.push({ full, rel });
    }
  }
  return out;
}

function allowed(rel) {
  return ALLOW_PATHS.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

function scan(files) {
  const hits = [];
  for (const file of files) {
    if (allowed(file.rel) && process.argv[2] !== "--self-test") continue;
    if (process.argv[2] === "--self-test" && file.rel !== FIXTURE) continue;
    const text = readFileSync(file.full, "utf8");
    for (const pattern of PATTERNS) {
      if (pattern.re.test(text)) {
        hits.push({ file: file.rel, pattern: pattern.name });
      }
    }
  }
  return hits;
}

if (process.argv[2] === "--self-test") {
  const files = listFiles(ROOT);
  const hits = scan(files);
  if (!hits.some((h) => h.file === FIXTURE)) {
    process.stderr.write("secret-scan self-test failed: fixture not detected\n");
    process.exit(1);
  }
  process.stdout.write("secret-scan self-test ok\n");
  process.exit(0);
}

const hits = scan(listFiles(ROOT));
if (hits.length) {
  process.stderr.write(`secret-scan failed:\n${hits.map((h) => `  ${h.file} (${h.pattern})`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("secret-scan ok\n");
