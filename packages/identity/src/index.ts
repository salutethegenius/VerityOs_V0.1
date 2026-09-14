import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PERMISSIONS, type PermissionKey } from "@verityos/contracts";
import { hashPassword, hashSecret, verifyPassword } from "./passwords.js";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = "verity_session";

export interface AuthContext {
  userId: string;
  organizationId: string;
  roleId: string;
  roleName: string;
  permissions: PermissionKey[];
  sessionId: string;
  kind: "session";
}

export interface ServiceContext {
  credentialId: string;
  organizationId: string | null;
  scopes: string[];
  kind: "service";
}

export type RequestContext = AuthContext | ServiceContext;

export class AuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const ADMIN_PERMISSIONS = [...PERMISSIONS];
const MEMBER_PERMISSIONS: PermissionKey[] = [
  "nova.use",
  "knowledge.read",
  "models.read",
  "policies.read",
  "approvals.read",
  "audit.read",
];

export async function createOrganization(
  pool: Pool,
  input: { name: string; adminEmail: string; adminPassword: string; adminName?: string }
): Promise<{
  organizationId: string;
  adminUserId: string;
  adminRoleId: string;
  memberRoleId: string;
}> {
  const organizationId = randomUUID();
  const adminUserId = randomUUID();
  const adminRoleId = randomUUID();
  const memberRoleId = randomUUID();
  const passwordHash = await hashPassword(input.adminPassword);
  const email = input.adminEmail.toLowerCase().trim();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO auth.organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [organizationId, input.name, slugify(input.name)]
    );
    await client.query(
      `INSERT INTO auth.users (id, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)`,
      [adminUserId, email, passwordHash, input.adminName ?? "Admin"]
    );
    await client.query(
      `INSERT INTO auth.roles (id, organization_id, name) VALUES ($1, $2, 'admin'), ($3, $2, 'member')`,
      [adminRoleId, organizationId, memberRoleId]
    );
    for (const key of ADMIN_PERMISSIONS) {
      await client.query(
        `INSERT INTO auth.role_permissions (role_id, permission_key) VALUES ($1, $2)`,
        [adminRoleId, key]
      );
    }
    for (const key of MEMBER_PERMISSIONS) {
      await client.query(
        `INSERT INTO auth.role_permissions (role_id, permission_key) VALUES ($1, $2)`,
        [memberRoleId, key]
      );
    }
    await client.query(
      `INSERT INTO auth.memberships (id, organization_id, user_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), organizationId, adminUserId, adminRoleId]
    );
    await client.query("COMMIT");
    return { organizationId, adminUserId, adminRoleId, memberRoleId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createUser(
  pool: Pool,
  input: {
    organizationId: string;
    roleId: string;
    email: string;
    password: string;
    displayName: string;
  }
): Promise<string> {
  const role = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM auth.roles WHERE id = $1`,
    [input.roleId]
  );
  if (!role.rows[0] || role.rows[0].organization_id !== input.organizationId) {
    throw new AuthError("INVALID_ROLE", "role is not in this organization", 400);
  }
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await pool.query(
    `INSERT INTO auth.users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)`,
    [userId, input.email.toLowerCase().trim(), passwordHash, input.displayName]
  );
  await pool.query(
    `INSERT INTO auth.memberships (id, organization_id, user_id, role_id)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), input.organizationId, userId, input.roleId]
  );
  return userId;
}

export async function createSession(
  pool: Pool,
  input: {
    email: string;
    password: string;
    organizationId?: string;
    ip?: string | null;
    userAgent?: string | null;
  }
): Promise<{ token: string; context: AuthContext }> {
  const email = input.email.toLowerCase().trim();
  const user = await pool.query<{
    id: string;
    password_hash: string;
    disabled_at: Date | null;
  }>(`SELECT id, password_hash, disabled_at FROM auth.users WHERE email = $1`, [email]);
  const dummy = "scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
  const row = user.rows[0];
  const ok = await verifyPassword(input.password, row?.password_hash ?? dummy);
  if (!row || row.disabled_at || !ok) {
    throw new AuthError("INVALID_CREDENTIALS", "invalid email or password");
  }
  const memberships = await pool.query<{
    organization_id: string;
    role_id: string;
    name: string;
  }>(
    `SELECT m.organization_id, m.role_id, r.name
     FROM auth.memberships m
     JOIN auth.roles r ON r.id = m.role_id
     WHERE m.user_id = $1
     ORDER BY m.created_at ASC`,
    [row.id]
  );
  if (memberships.rows.length === 0) {
    throw new AuthError("NO_MEMBERSHIP", "user has no organization membership", 403);
  }
  const membership = input.organizationId
    ? memberships.rows.find((m) => m.organization_id === input.organizationId)
    : memberships.rows[0];
  if (!membership) {
    throw new AuthError("NOT_A_MEMBER", "user is not a member of that organization", 403);
  }
  const token = randomBytes(32).toString("hex");
  const sessionId = randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO auth.sessions (id, user_id, organization_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      row.id,
      membership.organization_id,
      tokenHash(token),
      expires,
      input.ip ?? null,
      input.userAgent ?? null,
    ]
  );
  const permissions = await loadPermissions(pool, membership.role_id);
  return {
    token,
    context: {
      userId: row.id,
      organizationId: membership.organization_id,
      roleId: membership.role_id,
      roleName: membership.name,
      permissions,
      sessionId,
      kind: "session",
    },
  };
}

export async function destroySession(pool: Pool, token: string): Promise<void> {
  await pool.query(`DELETE FROM auth.sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

export async function resolveSession(pool: Pool, token: string | undefined): Promise<AuthContext> {
  if (!token) {
    throw new AuthError("UNAUTHENTICATED", "authentication required");
  }
  const result = await pool.query<{
    id: string;
    user_id: string;
    organization_id: string;
    role_id: string;
    name: string;
    expires_at: Date;
    disabled_at: Date | null;
  }>(
    `SELECT s.id, s.user_id, s.organization_id, m.role_id, r.name, s.expires_at, u.disabled_at
     FROM auth.sessions s
     JOIN auth.users u ON u.id = s.user_id
     JOIN auth.memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
     JOIN auth.roles r ON r.id = m.role_id
     WHERE s.token_hash = $1`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  if (!row || row.disabled_at || row.expires_at.getTime() <= Date.now()) {
    throw new AuthError("UNAUTHENTICATED", "authentication required");
  }
  const permissions = await loadPermissions(pool, row.role_id);
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
    roleName: row.name,
    permissions,
    sessionId: row.id,
    kind: "session",
  };
}

export async function selectOrganization(
  pool: Pool,
  userId: string,
  sessionId: string,
  organizationId: string
): Promise<void> {
  const member = await pool.query(
    `SELECT 1 FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
    [userId, organizationId]
  );
  if (member.rows.length === 0) {
    throw new AuthError("NOT_A_MEMBER", "user is not a member of that organization", 403);
  }
  await pool.query(`UPDATE auth.sessions SET organization_id = $2 WHERE id = $1`, [
    sessionId,
    organizationId,
  ]);
}

export function requirePermission(context: AuthContext, permission: PermissionKey): void {
  if (!context.permissions.includes(permission)) {
    throw new AuthError("FORBIDDEN", `missing permission ${permission}`, 403);
  }
}

export function assertOrganizationScope(
  contextOrganizationId: string,
  requestedOrganizationId: string | undefined
): string {
  if (requestedOrganizationId && requestedOrganizationId !== contextOrganizationId) {
    throw new AuthError("ORG_MISMATCH", "organization_id does not match authenticated context", 403);
  }
  return contextOrganizationId;
}

export async function loadPermissions(pool: Pool, roleId: string): Promise<PermissionKey[]> {
  const result = await pool.query<{ permission_key: PermissionKey }>(
    `SELECT permission_key FROM auth.role_permissions WHERE role_id = $1`,
    [roleId]
  );
  return result.rows.map((r) => r.permission_key);
}

export function generateServiceToken(): string {
  return `vsvc_${randomBytes(32).toString("base64url")}`;
}

export async function createRole(
  pool: Pool,
  input: { organizationId: string; name: string; permissions: PermissionKey[] }
): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO auth.roles (id, organization_id, name) VALUES ($1, $2, $3)`, [
    id,
    input.organizationId,
    input.name,
  ]);
  for (const key of input.permissions) {
    await pool.query(
      `INSERT INTO auth.role_permissions (role_id, permission_key) VALUES ($1, $2)`,
      [id, key]
    );
  }
  return id;
}

export async function createServiceCredential(
  pool: Pool,
  input: { name: string; organizationId: string | null; scopes: string[] }
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = generateServiceToken();
  await pool.query(
    `INSERT INTO auth.service_credentials (id, name, organization_id, secret_hash, scopes)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.name, input.organizationId, tokenHash(token), input.scopes]
  );
  return { id, token };
}

export async function revokeServiceCredential(pool: Pool, id: string): Promise<void> {
  const result = await pool.query(
    `UPDATE auth.service_credentials SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  );
  if (result.rowCount !== 1) {
    throw new AuthError("NOT_FOUND", "service credential not found", 404);
  }
}

export async function resolveServiceToken(
  pool: Pool,
  token: string | undefined
): Promise<ServiceContext> {
  if (!token) {
    throw new AuthError("UNAUTHENTICATED", "service authentication required");
  }
  const result = await pool.query<{
    id: string;
    organization_id: string | null;
    scopes: string[];
    revoked_at: Date | null;
  }>(
    `SELECT id, organization_id, scopes, revoked_at
     FROM auth.service_credentials
     WHERE secret_hash = $1`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at) {
    throw new AuthError("INVALID_SERVICE_CREDENTIALS", "invalid service credentials");
  }
  return {
    credentialId: row.id,
    organizationId: row.organization_id,
    scopes: row.scopes,
    kind: "service",
  };
}

export async function listOrganizationUsers(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, r.name AS role
     FROM auth.memberships m
     JOIN auth.users u ON u.id = m.user_id
     JOIN auth.roles r ON r.id = m.role_id
     WHERE m.organization_id = $1
     ORDER BY u.email`,
    [organizationId]
  );
  return result.rows;
}

export async function listOrganizationRoles(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT id, name FROM auth.roles WHERE organization_id = $1 ORDER BY name`,
    [organizationId]
  );
  return result.rows;
}

export { hashPassword, verifyPassword, hashSecret, tokenHash };
