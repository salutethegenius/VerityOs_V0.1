#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const skipE2E = process.env.RELEASE_CHECK_SKIP_E2E === "1";
const skipDocker = process.env.RELEASE_CHECK_SKIP_DOCKER === "1";
const skipLiveDemo = process.env.RELEASE_CHECK_SKIP_LIVE_DEMO !== "0";

const steps = [
  ["secret-scan", ["node", "scripts/secret-scan.mjs"]],
  ["secret-scan self-test", ["node", "scripts/secret-scan.mjs", "--self-test"]],
  ["dependency-scan", ["node", "scripts/dependency-scan.mjs"]],
  ["lint", ["pnpm", "lint"]],
  ["build", ["pnpm", "build"]],
  ["test", ["pnpm", "test"]],
  ["python tests", ["pnpm", "test:python"]],
  ["backup-restore smoke", ["bash", "scripts/backup-restore-smoke.sh"]],
];

if (!skipLiveDemo) {
  steps.push(["demo preflight", ["node", "scripts/demo-check.mjs"]]);
}
if (!skipE2E) {
  steps.push(["playwright e2e", ["pnpm", "test:e2e"]]);
}
if (!skipDocker) {
  steps.push(["docker audit-kernel", ["docker", "build", "-f", "infra/docker/audit-kernel.Dockerfile", "-t", "verityos-audit-kernel", "."]]);
}

let failed = 0;
for (const [name, argv] of steps) {
  process.stdout.write(`\n== ${name} ==\n`);
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.stdout.write(`FAIL ${name}\n`);
    failed += 1;
    if (name === "dependency-scan" && process.env.RELEASE_ALLOW_DEP_FINDINGS === "1") {
      process.stdout.write("dependency findings documented; continuing because RELEASE_ALLOW_DEP_FINDINGS=1\n");
      failed -= 1;
    }
  } else {
    process.stdout.write(`PASS ${name}\n`);
  }
}

process.stdout.write(failed ? `\nrelease check failed (${failed})\n` : "\nrelease check passed\n");
process.exit(failed ? 1 : 0);
