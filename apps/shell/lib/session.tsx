"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getMe, logout as logoutRequest } from "@/lib/api/auth";
import { CoreApiError, isUnauthorized } from "@/lib/api/client";
import type { SessionProfile } from "@/lib/api/types";

type SessionState = {
  me: SessionProfile | null;
  loading: boolean;
  error: CoreApiError | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<SessionProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CoreApiError | null>(null);

  async function refresh() {
    try {
      const profile = await getMe();
      setMe(profile);
      setError(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        setMe(null);
        if (pathname !== "/login") {
          router.replace("/login");
        }
        return;
      }
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "session failed", 500));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const value = useMemo<SessionState>(
    () => ({
      me,
      loading,
      error,
      refresh,
      logout: async () => {
        try {
          await logoutRequest();
        } finally {
          setMe(null);
          router.replace("/login");
        }
      },
    }),
    [me, loading, error, router]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
}
