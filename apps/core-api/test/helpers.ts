import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { createServiceCredential } from "@verityos/identity";
import { buildServer } from "../src/server.js";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit";

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
}

export async function startApp(pool: pg.Pool): Promise<FastifyInstance> {
  const { app } = await buildServer({ pool });
  return app;
}

export function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const match = list.find((c) => String(c).startsWith("verity_session="));
  if (!match) {
    throw new Error("missing session cookie");
  }
  return String(match).split(";")[0];
}

export async function seedPlatformService(pool: pg.Pool): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  await createServiceCredential(pool, {
    name: `platform-${randomUUID()}`,
    organizationId: null,
    scopes: ["organization.manage", "knowledge.read", "models.read"],
    secret,
  });
  return secret;
}

export async function createOrg(
  app: FastifyInstance,
  serviceToken: string,
  name: string
) {
  const email = `${name.replace(/\s+/g, "-").toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "correct-horse-battery";
  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/organizations",
    headers: { authorization: `Bearer ${serviceToken}` },
    payload: {
      name,
      admin_email: email,
      admin_password: password,
      admin_name: `${name} Admin`,
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`create org failed ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    organization_id: string;
    admin_user_id: string;
    admin_role_id: string;
    member_role_id: string;
  };
  return { ...body, email, password };
}

export async function login(app: FastifyInstance, email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed ${response.statusCode} ${response.body}`);
  }
  return { cookie: sessionCookie(response), body: response.json() };
}

export function markdownPart(filename: string, body: string, title: string): Buffer {
  const boundary = "----veritytest";
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="title"`,
    "",
    title,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: text/markdown",
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(payload);
}
