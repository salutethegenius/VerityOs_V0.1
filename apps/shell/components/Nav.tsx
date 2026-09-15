"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRIMARY_NAV, visibleNav } from "@/lib/permissions";
import { useSession } from "@/lib/session";

export function Nav() {
  const { me } = useSession();
  const pathname = usePathname();
  const items = visibleNav(PRIMARY_NAV, me?.permissions);
  return (
    <nav aria-label="Primary" className="flex flex-row gap-1 overflow-x-auto px-3 py-3 md:flex-col md:py-4">
      {items.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : item.label === "Command"
              ? pathname.startsWith("/command")
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-sm px-3 py-2 text-sm ${
              isActive ? "bg-white/10 text-white" : "text-[var(--rail-muted)] hover:bg-white/5 hover:text-[var(--rail-ink)]"
            }`}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
