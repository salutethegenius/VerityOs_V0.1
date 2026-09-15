"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COMMAND_NAV, visibleNav } from "@/lib/permissions";
import { useSession } from "@/lib/session";

export default function CommandLayout({ children }: { children: React.ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const items = visibleNav(COMMAND_NAV, me?.permissions);
  return (
    <div>
      <nav aria-label="Command" className="mb-5 flex flex-wrap gap-2 border-b border-line pb-3">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`px-2 py-1 text-sm ${pathname === item.href ? "font-semibold text-accent" : "text-muted hover:text-ink"}`}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
