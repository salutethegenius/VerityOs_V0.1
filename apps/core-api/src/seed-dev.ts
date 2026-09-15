import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createOrganization, createServiceCredential, createUser } from "@verityos/identity";
import { seedDefaultCommand } from "@verityos/command";
import { writeRepoSeedFile } from "./seed-paths.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit";
const EMAIL = (process.env.SEED_ADMIN_EMAIL ?? "admin@verity.local").toLowerCase();
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "verity-dev-admin";
const MEMBER_EMAIL = (process.env.SEED_MEMBER_EMAIL ?? "member@verity.local").toLowerCase();
const MEMBER_PASSWORD = process.env.SEED_MEMBER_PASSWORD ?? "verity-dev-member";
const ORG_NAME = process.env.SEED_ORG_NAME ?? "Verity Demo";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    const existing = await pool.query<{
      user_id: string;
      organization_id: string;
      role_id: string;
    }>(
      `SELECT u.id AS user_id, m.organization_id, m.role_id
       FROM auth.users u
       JOIN auth.memberships m ON m.user_id = u.id
       WHERE u.email = $1
       LIMIT 1`,
      [EMAIL]
    );

    let organizationId: string;
    let adminUserId: string;
    let memberRoleId: string;
    if (existing.rows[0]) {
      organizationId = existing.rows[0].organization_id;
      adminUserId = existing.rows[0].user_id;
      const memberRole = await pool.query<{ id: string }>(
        `SELECT id FROM auth.roles WHERE organization_id = $1 AND name = 'member'`,
        [organizationId]
      );
      memberRoleId = memberRole.rows[0].id;
    } else {
      const created = await createOrganization(pool, {
        name: ORG_NAME,
        adminEmail: EMAIL,
        adminPassword: PASSWORD,
        adminName: "Verity Admin",
      });
      await seedDefaultCommand(pool, {
        organizationId: created.organizationId,
        adminRoleId: created.adminRoleId,
        memberRoleId: created.memberRoleId,
      });
      organizationId = created.organizationId;
      adminUserId = created.adminUserId;
      memberRoleId = created.memberRoleId;
    }

    const memberExists = await pool.query(`SELECT 1 FROM auth.users WHERE email = $1`, [MEMBER_EMAIL]);
    if (memberExists.rowCount === 0) {
      await createUser(pool, {
        organizationId,
        roleId: memberRoleId,
        email: MEMBER_EMAIL,
        password: MEMBER_PASSWORD,
        displayName: "Verity Member",
      });
    }

    const voice = "Warm, precise institutional voice. Do not invent legal claims.";
    const config = { display_name: "Acme" };
    const configHash = sha256(
      JSON.stringify({
        brand_id: "acme",
        config_version: 1,
        voice_md: voice,
        config,
      })
    );
    await pool.query(
      `INSERT INTO social.brands (
         id, organization_id, brand_id, display_name, active, voice_md, config_json,
         content_pillars, visual_identity, platforms, posting_cadence_days,
         config_version, config_hash
       ) VALUES (
         $1, $2, 'acme', 'Acme', true, $3, $4::jsonb,
         $5::jsonb, '{}'::jsonb, '["facebook"]'::jsonb, 3, 1, $6
       )
       ON CONFLICT (organization_id, brand_id) DO UPDATE SET active = true`,
      [
        randomUUID(),
        organizationId,
        voice,
        JSON.stringify(config),
        JSON.stringify([{ pillar: "Education", description: "teach from approved sources" }]),
        configHash,
      ]
    );

    await pool.query(
      `UPDATE command.connectors
       SET enabled = true,
           secret_ref = 'META_PAGE_ACCESS_TOKEN',
           page_config = jsonb_build_object('page_id', 'page-dev')
       WHERE organization_id = $1 AND connector_key = 'meta.facebook'`,
      [organizationId]
    );

    if (process.env.SEED_EXPIRE_PENDING === "1") {
      await pool.query(
        `UPDATE command.approvals
         SET status = 'denied', reason_code = 'E2E_RESET'
         WHERE organization_id = $1 AND status = 'pending'`,
        [organizationId]
      );
    }

    const novaCred = await createServiceCredential(pool, {
      name: `nova-dev-${randomUUID().slice(0, 8)}`,
      organizationId,
      scopes: ["knowledge.read", "models.read", "executions.write"],
    });
    const internalToken = process.env.NOVA_INTERNAL_TOKEN ?? `dev-internal-${randomUUID()}`;

    const payload = {
      organization_id: organizationId,
      admin_user_id: adminUserId,
      email: EMAIL,
      password: PASSWORD,
      member_email: MEMBER_EMAIL,
      member_password: MEMBER_PASSWORD,
      nova_service_token: novaCred.token,
      nova_internal_token: internalToken,
    };
    const seedFile = writeRepoSeedFile("verity-dev-seed.json", payload);
    process.stdout.write(
      [
        "Seeded development organization.",
        "  logins (local development only):",
        `    admin  ${EMAIL} / ${PASSWORD}`,
        `    member ${MEMBER_EMAIL} / ${MEMBER_PASSWORD}`,
        "  member drafts; admin approves (self-approval is denied).",
        `  seed file: ${seedFile.relative}`,
        `  seed file (absolute): ${seedFile.absolute}`,
        "  Nova service/internal tokens are in the seed file — not printed.",
        "",
      ].join("\n")
    );
  } finally {
    await pool.end();
  }
}

await main();
