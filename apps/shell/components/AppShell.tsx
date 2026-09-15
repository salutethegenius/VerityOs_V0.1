"use client";

import { usePathname } from "next/navigation";
import { Header } from "@/components/Header";
import { Nav } from "@/components/Nav";
import { ErrorState, LoadingState } from "@/components/ui";
import { useSession } from "@/lib/session";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, loading, error, refresh } = useSession();
  const pathname = usePathname();
  if (pathname === "/login") {
    return <>{children}</>;
  }
  if (loading && !me) {
    return (
      <div className="p-8">
        <LoadingState label="Restoring session" />
      </div>
    );
  }
  if (error && !me) {
    return (
      <div className="p-8">
        <ErrorState message={error.message} requestId={error.requestId} onRetry={() => void refresh()} />
      </div>
    );
  }
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">
        Skip to main content
      </a>
      <aside className="flex w-full shrink-0 flex-col bg-rail text-[var(--rail-ink)] md:w-56">
        <div className="border-b border-white/10 px-5 py-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--rail-muted)]">Operating environment</p>
          <p className="mt-1 text-lg font-semibold tracking-tight">VerityOS</p>
        </div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main id="main" className="flex-1 overflow-x-auto px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
