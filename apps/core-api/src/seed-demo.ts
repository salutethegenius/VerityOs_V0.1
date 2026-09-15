import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { createOrganization, createServiceCredential, createUser } from "@verityos/identity";
import { seedDefaultCommand } from "@verityos/command";
import {
  approveSourceVersion,
  createCollection,
  indexSourceVersion,
  uploadSourceVersion,
} from "@verityos/knowledge";
import { assertDemoResetAllowed, DEMO_ORG_NAME, resolveProfile } from "./runtime-config.js";
import { wipeOrganization } from "./demo-wipe.js";

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "../demo-pack");

function password(envName: string, fallbackDev: string): string {
  if (process.env[envName]) {
    return process.env[envName] as string;
  }
  if (resolveProfile() === "development") {
    return fallbackDev;
  }
  return `demo-${randomBytes(12).toString("base64url")}`;
}

function syntheticPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = Buffer.from(`BT /F1 12 Tf 48 720 Td (${escaped}) Tj ET\n`, "latin1");
  const compressed = deflateSync(stream);
  const objects: Buffer[] = [];
  const add = (n: number, body: Buffer) => {
    objects[n] = Buffer.concat([
      Buffer.from(`${n} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
  };
  add(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  add(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"));
  add(
    3,
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "latin1"
    )
  );
  add(4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"));
  add(
    5,
    Buffer.concat([
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      compressed,
      Buffer.from("\nendstream", "latin1"),
    ])
  );
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const parts: Buffer[] = [header];
  const offsets = [0];
  let offset = header.length;
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = offset;
    parts.push(objects[i]);
    offset += objects[i].length;
  }
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  return Buffer.concat([
    ...parts,
    Buffer.from(xref, "latin1"),
    Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"),
  ]);
}

async function main() {
  assertDemoResetAllowed();
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit";
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM auth.organizations WHERE name = $1`,
      [DEMO_ORG_NAME]
    );
    if (existing.rows[0]) {
      await wipeOrganization(pool, existing.rows[0].id);
    }

    const directorEmail = (process.env.DEMO_DIRECTOR_EMAIL ?? "director@verity-demo.local").toLowerCase();
    const officerEmail = (process.env.DEMO_OFFICER_EMAIL ?? "communications@verity-demo.local").toLowerCase();
    const analystEmail = (process.env.DEMO_ANALYST_EMAIL ?? "analyst@verity-demo.local").toLowerCase();
    const directorPassword = password("DEMO_DIRECTOR_PASSWORD", "verity-demo-director");
    const officerPassword = password("DEMO_OFFICER_PASSWORD", "verity-demo-officer");
    const analystPassword = password("DEMO_ANALYST_PASSWORD", "verity-demo-analyst");

    const created = await createOrganization(pool, {
      name: DEMO_ORG_NAME,
      adminEmail: directorEmail,
      adminPassword: directorPassword,
      adminName: "Director",
    });
    await seedDefaultCommand(pool, {
      organizationId: created.organizationId,
      adminRoleId: created.adminRoleId,
      memberRoleId: created.memberRoleId,
    });

    const officerId = await createUser(pool, {
      organizationId: created.organizationId,
      roleId: created.memberRoleId,
      email: officerEmail,
      password: officerPassword,
      displayName: "Communications Officer",
    });

    const analystRoleId = randomUUID();
    await pool.query(`INSERT INTO auth.roles (id, organization_id, name) VALUES ($1, $2, 'analyst')`, [
      analystRoleId,
      created.organizationId,
    ]);
    for (const key of ["nova.use", "knowledge.read", "models.read", "policies.read", "audit.read"]) {
      await pool.query(`INSERT INTO auth.role_permissions (role_id, permission_key) VALUES ($1, $2)`, [
        analystRoleId,
        key,
      ]);
    }
    const researchPolicy = await pool.query<{ id: string }>(
      `SELECT id FROM command.skill_policies WHERE organization_id = $1 AND skill_id = 'nova.research'`,
      [created.organizationId]
    );
    if (researchPolicy.rows[0]) {
      await pool.query(
        `INSERT INTO command.skill_policy_roles (skill_policy_id, role_id, organization_id) VALUES ($1, $2, $3)`,
        [researchPolicy.rows[0].id, analystRoleId, created.organizationId]
      );
    }
    const analystId = await createUser(pool, {
      organizationId: created.organizationId,
      roleId: analystRoleId,
      email: analystEmail,
      password: analystPassword,
      displayName: "Analyst",
    });

    await pool.query(
      `UPDATE command.connectors
       SET enabled = true, secret_ref = 'META_PAGE_ACCESS_TOKEN',
           page_config = jsonb_build_object('page_id', 'page-demo')
       WHERE organization_id = $1 AND connector_key = 'meta.facebook'`,
      [created.organizationId]
    );

    const collectionId = await createCollection(pool, {
      organizationId: created.organizationId,
      name: "Institutional Guidance (Synthetic Demo)",
      classification: "internal",
      createdBy: created.adminUserId,
      adminRoleId: created.adminRoleId,
      memberRoleId: created.memberRoleId,
    });
    await pool.query(
      `INSERT INTO knowledge.collection_permissions (
         id, collection_id, organization_id, role_id, can_read, can_manage, can_approve
       ) VALUES ($1, $2, $3, $4, true, false, false)`,
      [randomUUID(), collectionId, created.organizationId, analystRoleId]
    );

    const files = readdirSync(PACK_DIR).filter((name) => !name.startsWith("."));
    for (const filename of files) {
      const bytes = readFileSync(join(PACK_DIR, filename));
      const uploaded = await uploadSourceVersion(pool, {
        organizationId: created.organizationId,
        collectionId,
        actorId: created.adminUserId,
        title: filename.replace(/\.[^.]+$/, "").replace(/-/g, " "),
        filename,
        bytes,
      });
      await approveSourceVersion(pool, {
        organizationId: created.organizationId,
        versionId: uploaded.versionId,
        actorId: created.adminUserId,
      });
      await indexSourceVersion(pool, {
        organizationId: created.organizationId,
        versionId: uploaded.versionId,
      });
    }

    const pdf = syntheticPdf(
      "SYNTHETIC DEMO DOCUMENT NOT OFFICIAL GOVERNMENT POLICY. Public warning channels: use designated public shelters listed in the Hurricane Shelter Operations Guide. Do not publish unofficial casualty counts."
    );
    const pdfUpload = await uploadSourceVersion(pool, {
      organizationId: created.organizationId,
      collectionId,
      actorId: created.adminUserId,
      title: "public warning channels",
      filename: "public-warning-channels.pdf",
      bytes: pdf,
    });
    await approveSourceVersion(pool, {
      organizationId: created.organizationId,
      versionId: pdfUpload.versionId,
      actorId: created.adminUserId,
    });
    await indexSourceVersion(pool, {
      organizationId: created.organizationId,
      versionId: pdfUpload.versionId,
    });

    const voice =
      "Precise institutional voice. Never invent official facts. Mark every extract as synthetic demo guidance.";
    const config = { display_name: "Demo Civil Protection" };
    await pool.query(
      `INSERT INTO social.brands (
         id, organization_id, brand_id, display_name, active, voice_md, config_json,
         content_pillars, visual_identity, platforms, posting_cadence_days,
         config_version, config_hash
       ) VALUES (
         $1, $2, 'civil-protection', 'Demo Civil Protection', true, $3, $4::jsonb,
         $5::jsonb, '{}'::jsonb, '["facebook"]'::jsonb, 1, 1, $6
       )`,
      [
        randomUUID(),
        created.organizationId,
        voice,
        JSON.stringify(config),
        JSON.stringify([{ pillar: "Public safety", description: "approved shelter and flood guidance" }]),
        randomBytes(32).toString("hex"),
      ]
    );

    const novaCred = await createServiceCredential(pool, {
      name: `nova-demo-${randomUUID().slice(0, 8)}`,
      organizationId: created.organizationId,
      scopes: ["knowledge.read", "models.read", "executions.write"],
    });
    const internalToken = process.env.NOVA_INTERNAL_TOKEN ?? `demo-internal-${randomUUID()}`;

    const payload = {
      organization_id: created.organizationId,
      organization: DEMO_ORG_NAME,
      director_email: directorEmail,
      director_password: directorPassword,
      officer_email: officerEmail,
      officer_password: officerPassword,
      analyst_email: analystEmail,
      analyst_password: analystPassword,
      director_user_id: created.adminUserId,
      officer_user_id: officerId,
      analyst_user_id: analystId,
      collection_id: collectionId,
      nova_service_token: novaCred.token,
      nova_internal_token: internalToken,
      synthetic: true,
    };
    mkdirSync("tmp", { recursive: true });
    writeFileSync("tmp/verity-demo-seed.json", JSON.stringify(payload, null, 2));
    process.stdout.write(
      [
        "Seeded synthetic government communications demo.",
        `  org: ${DEMO_ORG_NAME}`,
        `  director: ${directorEmail} / ${directorPassword}`,
        `  officer: ${officerEmail} / ${officerPassword}`,
        `  analyst: ${analystEmail} / ${analystPassword}`,
        "  documents: SYNTHETIC DEMO DOCUMENT / NOT OFFICIAL GOVERNMENT POLICY",
        "  nova tokens: tmp/verity-demo-seed.json (not printed)",
        "Printed once. Rotate before any non-demo use.",
        "",
      ].join("\n")
    );
  } finally {
    await pool.end();
  }
}

await main();
