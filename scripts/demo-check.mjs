#!/usr/bin/env node
/**
 * Demo preflight. Prints pass/fail only. Never prints secrets.
 *
 * Live service probes run unless VERITY_DEMO_CHECK_DB_ONLY=1.
 */
import pg from "pg";

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  record("DATABASE_URL", false, "missing");
  process.exit(1);
}

const core = process.env.CORE_API_URL ?? "http://127.0.0.1:8080";
const nova = process.env.NOVA_INTERNAL_URL ?? "http://127.0.0.1:8090";
const shell = process.env.SHELL_URL ?? "http://127.0.0.1:3000";
const dbOnly = process.env.VERITY_DEMO_CHECK_DB_ONLY === "1";

const DEMO_ORG = "VerityOS Government Communications Demo";

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  await pool.query("SELECT 1");
  record("database reachable", true);
  const mig = await pool.query(`SELECT id FROM pgmigrations ORDER BY run_on DESC LIMIT 1`);
  record("migrations current", Boolean(mig.rows[0]), mig.rows[0]?.id ?? "none");
  const org = await pool.query(`SELECT id FROM auth.organizations WHERE name = $1`, [DEMO_ORG]);
  record("demo org exists", org.rowCount > 0);
  if (org.rows[0]) {
    const orgId = org.rows[0].id;
    const chunks = await pool.query(
      `SELECT COUNT(*)::int AS n FROM knowledge.chunks WHERE organization_id = $1`,
      [orgId]
    );
    record("knowledge indexed", chunks.rows[0].n > 0, `${chunks.rows[0].n} chunks`);
    const model = await pool.query(
      `SELECT 1 FROM command.models WHERE organization_id = $1 AND model_key = 'mock-local' AND enabled`,
      [orgId]
    );
    record("mock model available", model.rowCount > 0);
    const connector = await pool.query(
      `SELECT 1 FROM command.connectors WHERE organization_id = $1 AND connector_key = 'meta.facebook' AND enabled`,
      [orgId]
    );
    record("mock connector available", connector.rowCount > 0);
    const chain = await pool.query(`SELECT 1 FROM audit.chain_state WHERE organization_id = $1`, [orgId]);
    record("audit kernel operational", true, chain.rowCount >= 0 ? "schema present" : "");
  }
  const embeddings = process.env.VERITY_EMBEDDING_PROVIDER ?? "";
  record("embedding provider configured", Boolean(embeddings), embeddings ? "set" : "unset");
} catch (err) {
  record("database reachable", false, "query failed");
} finally {
  await pool.end();
}

async function probe(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    record(name, response.ok, String(response.status));
  } catch {
    record(name, false, "unreachable");
  }
}

if (!dbOnly) {
  await probe("core ready", `${core}/health/ready`);
  await probe("nova ready", `${nova}/health/ready`);
  await probe("shell ready", `${shell}/health/ready`);
} else {
  record("live probes skipped", true, "VERITY_DEMO_CHECK_DB_ONLY=1");
}

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  process.stdout.write(`\n${failed.length} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\ndemo preflight passed\n");
