import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit";

function run(command, args, extraEnv = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL, ...extraEnv },
  });
}

async function waitFor(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(400);
  }
  throw new Error(`timeout waiting for ${url}`);
}

const children = [];
let shuttingDown = false;

function track(child, name) {
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      process.stderr.write(`${name} exited ${code} ${signal ?? ""}\n`);
      shutdown();
      process.exit(code);
    }
  });
  return child;
}

function shutdown() {
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  children.length = 0;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function killLeftovers() {
  try {
    execSync(
      "pkill -f 'next-server \\(v' || true; pkill -f 'playwright test' || true; pkill -f 'meta-mock.mjs' || true; pkill -f 'apps/core-api/dist/start.js' || true; pkill -f 'verityos_nova.app.main' || true; fuser -k 3000/tcp 8080/tcp 8090/tcp 8099/tcp 2>/dev/null || true",
      { stdio: "ignore" }
    );
  } catch {
    // no leftover processes
  }
}

async function seed(script, extraEnv = {}) {
  const child = run("node", [script], extraEnv);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) {
    process.exit(code ?? 1);
  }
}

async function startStack(seed, extraEnv = {}) {
  track(run("node", ["scripts/meta-mock.mjs"]), "meta-mock");
  track(
    run("node", ["apps/core-api/dist/start.js"], {
      PORT: "8080",
      CORS_ORIGIN: "http://127.0.0.1:3000",
      COOKIE_SECURE: "false",
      VERITY_EMBEDDING_PROVIDER: "mock",
      VERITY_DATA_DIR: process.env.VERITY_DATA_DIR ?? "/tmp/verity-data",
      NOVA_INTERNAL_URL: "http://127.0.0.1:8090",
      NOVA_INTERNAL_TOKEN: seed.nova_internal_token,
      META_GRAPH_BASE: "http://127.0.0.1:8099",
      META_PAGE_ACCESS_TOKEN: "fake-page-token",
      VERITY_PROFILE: extraEnv.VERITY_PROFILE ?? "development",
      VERITY_DEPLOYMENT_PROFILE: extraEnv.VERITY_PROFILE ?? "development",
      ...extraEnv,
    }),
    "core-api"
  );
  await waitFor("http://127.0.0.1:8080/v1/health");
  track(
    run(
      "python3",
      ["-m", "uvicorn", "verityos_nova.app.main:create_dev_app", "--factory", "--host", "127.0.0.1", "--port", "8090"],
      {
        NOVA_DEV_MODE: "1",
        CORE_API_URL: "http://127.0.0.1:8080",
        NOVA_SERVICE_TOKEN: seed.nova_service_token,
        NOVA_ORGANIZATION_ID: seed.organization_id,
        NOVA_SYSTEM_ACTOR_ID: seed.director_user_id ?? seed.admin_user_id,
        NOVA_INTERNAL_TOKEN: seed.nova_internal_token,
        PYTHONPATH: `${process.cwd()}/apps/nova/src`,
      }
    ),
    "nova"
  );
  await waitFor("http://127.0.0.1:8090/health");
  track(
    run("pnpm", ["--filter", "@verityos/shell", "start"], {
      CORE_API_URL: "http://127.0.0.1:8080",
      PORT: "3000",
    }),
    "shell"
  );
  await waitFor("http://127.0.0.1:3000/login");
}

async function playwright(specs, env) {
  const child = run("pnpm", ["--filter", "@verityos/shell", "test:e2e", "--", ...specs], env);
  return new Promise((resolve) => child.on("exit", resolve));
}

mkdirSync("tmp", { recursive: true });
killLeftovers();

await seed("apps/core-api/dist/seed-dev.js", { SEED_EXPIRE_PENDING: "1" });
if (!existsSync("tmp/verity-dev-seed.json")) {
  throw new Error("seed file missing");
}
const devSeed = JSON.parse(readFileSync("tmp/verity-dev-seed.json", "utf8"));
await startStack(devSeed, { VERITY_PROFILE: "development" });
let code = await playwright(["e2e/research.spec.ts", "e2e/social.spec.ts"], {
  SEED_ADMIN_EMAIL: devSeed.email,
  SEED_ADMIN_PASSWORD: devSeed.password,
  SEED_MEMBER_EMAIL: devSeed.member_email,
  SEED_MEMBER_PASSWORD: devSeed.member_password,
  SHELL_URL: "http://127.0.0.1:3000",
});
shutdown();
await delay(800);
if (code !== 0) {
  process.exit(code ?? 1);
}

killLeftovers();
await seed("apps/core-api/dist/seed-demo.js", {
  VERITY_PROFILE: "development",
  VERITY_DEMO_RESET: "1",
  VERITY_EMBEDDING_PROVIDER: "mock",
  VERITY_DATA_DIR: process.env.VERITY_DATA_DIR ?? "/tmp/verity-data",
});
if (!existsSync("tmp/verity-demo-seed.json")) {
  throw new Error("demo seed file missing");
}
const demoSeed = JSON.parse(readFileSync("tmp/verity-demo-seed.json", "utf8"));
shuttingDown = false;
await startStack(demoSeed, { VERITY_PROFILE: "development" });
code = await playwright(["e2e/government.spec.ts"], {
  DEMO_DIRECTOR_EMAIL: demoSeed.director_email,
  DEMO_DIRECTOR_PASSWORD: demoSeed.director_password,
  DEMO_OFFICER_EMAIL: demoSeed.officer_email,
  DEMO_OFFICER_PASSWORD: demoSeed.officer_password,
  DEMO_ANALYST_EMAIL: demoSeed.analyst_email,
  DEMO_ANALYST_PASSWORD: demoSeed.analyst_password,
  SHELL_URL: "http://127.0.0.1:3000",
});
shutdown();
process.exit(code ?? 1);
