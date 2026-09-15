#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

mkdirSync("tmp", { recursive: true });

function run(name, argv, opts = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    env: process.env,
    ...opts,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`tmp/${name}.log`, output);
  return { status: result.status ?? 1, output };
}

const findings = [];

const pnpm = run("pnpm-audit", ["pnpm", "audit", "--json", "--audit-level", "moderate"]);
try {
  const parsed = JSON.parse(pnpm.output.split("\n").filter((l) => l.trim().startsWith("{")).pop() || "{}");
  const advisories = parsed.advisories
    ? Object.values(parsed.advisories)
    : parsed.metadata?.vulnerabilities
      ? []
      : [];
  const high = (advisories || []).filter((a) => ["high", "critical"].includes(String(a.severity ?? "").toLowerCase()));
  if (parsed.metadata?.vulnerabilities) {
    const v = parsed.metadata.vulnerabilities;
    if ((v.high ?? 0) + (v.critical ?? 0) > 0) {
      findings.push(`pnpm audit: high=${v.high ?? 0} critical=${v.critical ?? 0} (see tmp/pnpm-audit.log)`);
    }
  } else if (high.length) {
    findings.push(`pnpm audit: ${high.length} high/critical advisories`);
  }
} catch {
  if (pnpm.status !== 0) {
    findings.push("pnpm audit failed to parse; see tmp/pnpm-audit.log");
  }
}

const pip = run("pip-audit", ["python3", "-m", "pip_audit", "-r", "apps/nova/pyproject.toml", "--skip-editable"]);
if (pip.status === 0) {
  // ok
} else if (pip.output.includes("No module named pip_audit") || pip.output.includes("No module named pip-audit")) {
  process.stdout.write("pip-audit not installed; skipping Python scan (install pip-audit for release)\n");
} else if (pip.status !== 0) {
  const block = /CRITICAL|HIGH/.test(pip.output);
  if (block) {
    findings.push("pip-audit reported HIGH/CRITICAL findings; see tmp/pip-audit.log");
  } else {
    process.stdout.write("pip-audit returned non-zero without HIGH/CRITICAL; see tmp/pip-audit.log\n");
  }
}

if (findings.length) {
  process.stderr.write(findings.map((f) => `FAIL  ${f}`).join("\n") + "\n");
  process.stderr.write("See docs/security/dependency-policy.md for exceptions.\n");
  process.exit(1);
}
process.stdout.write("dependency-scan ok\n");
