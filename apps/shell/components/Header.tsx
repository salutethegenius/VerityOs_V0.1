"use client";

import { useSession } from "@/lib/session";
import { StatusPill } from "@/components/ui";

export function Header() {
  const { me, logout } = useSession();
  const env = process.env.NEXT_PUBLIC_VERITY_ENV;
  return (
    <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-6">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{me?.organization || "Organization"}</p>
        <p className="truncate text-xs text-muted">{me?.display_name} · {me?.role}</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn" onClick={() => void logout()}>
          Log out
        </button>
        {env ? <StatusPill label={env} /> : null}
      </div>
    </header>
  );
}
