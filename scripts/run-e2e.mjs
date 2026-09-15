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
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

mkdirSync("tmp", { recursive: true });
try {
  execSync("pkill -f 'next-server \\(v' || true; pkill -f 'playwright test' || true", { stdio: "ignore" });
} catch {
  // no leftover processes
}
const seeded = run("node", ["apps/core-api/dist/seed-dev.js"], {
  DATABASE_URL,
  SEED_EXPIRE_PENDING: "1",
});
const seedCode = await new Promise((resolve) => seeded.on("exit", resolve));
if (seedCode !== 0) {
  process.exit(seedCode ?? 1);
}
if (!existsSync("tmp/verity-dev-seed.json")) {
  throw new Error("seed file missing");
}
const seed = JSON.parse(readFileSync("tmp/verity-dev-seed.json", "utf8"));

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
    VERITY_DEPLOYMENT_PROFILE: "development",
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
      NOVA_SYSTEM_ACTOR_ID: seed.admin_user_id,
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

const playwright = run("pnpm", ["--filter", "@verityos/shell", "test:e2e"], {
  SEED_ADMIN_EMAIL: seed.email,
  SEED_ADMIN_PASSWORD: seed.password,
  SEED_MEMBER_EMAIL: seed.member_email,
  SEED_MEMBER_PASSWORD: seed.member_password,
  SHELL_URL: "http://127.0.0.1:3000",
});
const code = await new Promise((resolve) => playwright.on("exit", resolve));
shutdown();
process.exit(code ?? 1);
