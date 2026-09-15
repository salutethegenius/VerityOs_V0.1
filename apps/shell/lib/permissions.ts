export type NavItem = {
  href: string;
  label: string;
  permission?: string;
  anyOf?: string[];
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/nova", label: "Nova", permission: "nova.use" },
  { href: "/knowledge", label: "Knowledge", permission: "knowledge.read" },
  {
    href: "/command/users",
    label: "Command",
    anyOf: [
      "users.manage",
      "roles.manage",
      "policies.read",
      "models.read",
      "approvals.read",
      "connectors.manage",
    ],
  },
  { href: "/audit", label: "Audit", permission: "audit.read" },
  { href: "/system", label: "System" },
];

export const COMMAND_NAV: NavItem[] = [
  { href: "/command/users", label: "Users", permission: "users.manage" },
  { href: "/command/roles", label: "Roles", permission: "roles.manage" },
  { href: "/command/policies", label: "Policies", permission: "policies.read" },
  { href: "/command/models", label: "Models", permission: "models.read" },
  { href: "/command/skills", label: "Skills", permission: "policies.read" },
  { href: "/command/connectors", label: "Connectors", permission: "connectors.manage" },
  { href: "/command/approvals", label: "Approvals", permission: "approvals.read" },
];

export function can(permissions: string[] | undefined, key?: string): boolean {
  if (!key) return true;
  return Boolean(permissions?.includes(key));
}

export function canAny(permissions: string[] | undefined, keys?: string[]): boolean {
  if (!keys?.length) return true;
  return keys.some((key) => permissions?.includes(key));
}

export function visibleNav(items: NavItem[], permissions: string[] | undefined): NavItem[] {
  return items.filter((item) => can(permissions, item.permission) && canAny(permissions, item.anyOf));
}
