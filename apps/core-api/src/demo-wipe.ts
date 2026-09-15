import type { Pool } from "pg";

const DELETE_ORDER = [
  "knowledge.retrieval_hits",
  "knowledge.retrieval_runs",
  "knowledge.chunks",
  "knowledge.source_versions",
  "knowledge.sources",
  "knowledge.collection_permissions",
  "knowledge.collections",
  "social.content_items",
  "social.onboarding_sessions",
  "social.brands",
  "nova.skill_runs",
  "nova.external_identities",
  "command.connector_actions",
  "command.approvals",
  "command.skill_connectors",
  "command.skill_policy_roles",
  "command.skill_policies",
  "command.policy_bindings",
  "command.policies",
  "command.models",
  "command.connectors",
  "audit.execution_events",
  "audit.merkle_checkpoints",
];

/** Append-only Audit tables. Disabled only inside a demo/dev org wipe transaction. */
const APPEND_ONLY_TRIGGERS = [
  { table: "audit.execution_events", trigger: "execution_events_reject_update_delete" },
  { table: "audit.ledger_entries", trigger: "ledger_entries_reject_update_delete" },
  { table: "audit.merkle_checkpoints", trigger: "merkle_checkpoints_reject_update_delete" },
] as const;

export async function wipeOrganization(pool: Pool, organizationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Demo/dev reset only: recreate the synthetic org. Not a production evidence-deletion API.
    for (const { table, trigger } of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    for (const table of DELETE_ORDER) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId]);
    }
    await client.query(`UPDATE audit.executions SET final_entry_id = NULL WHERE organization_id = $1`, [
      organizationId,
    ]);
    await client.query(`DELETE FROM audit.ledger_entries WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM audit.executions WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM audit.chain_state WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM auth.sessions WHERE organization_id = $1`, [organizationId]);
    const users = await client.query<{ user_id: string }>(
      `SELECT user_id FROM auth.memberships WHERE organization_id = $1`,
      [organizationId]
    );
    await client.query(`DELETE FROM auth.memberships WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM auth.role_permissions WHERE role_id IN (SELECT id FROM auth.roles WHERE organization_id = $1)`, [
      organizationId,
    ]);
    await client.query(`DELETE FROM auth.roles WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM auth.service_credentials WHERE organization_id = $1`, [organizationId]);
    for (const row of users.rows) {
      const other = await client.query(
        `SELECT 1 FROM auth.memberships WHERE user_id = $1 LIMIT 1`,
        [row.user_id]
      );
      if (other.rowCount === 0) {
        await client.query(`DELETE FROM auth.users WHERE id = $1`, [row.user_id]);
      }
    }
    await client.query(`DELETE FROM auth.organizations WHERE id = $1`, [organizationId]);
    for (const { table, trigger } of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
