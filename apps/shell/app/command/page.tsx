"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { COMMAND_NAV, visibleNav } from "@/lib/permissions";
import { useSession } from "@/lib/session";

export default function CommandIndex() {
  const { me } = useSession();
  const router = useRouter();
  const first = visibleNav(COMMAND_NAV, me?.permissions)[0]?.href ?? "/";
  useEffect(() => {
    router.replace(first);
  }, [first, router]);
  return (
    <p className="text-sm text-muted" role="status">
      Opening Command…
    </p>
  );
}
