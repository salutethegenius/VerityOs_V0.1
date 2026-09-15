"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api/auth";
import { CoreApiError } from "@/lib/api/client";
import { ErrorState } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function LoginPage() {
  const router = useRouter();
  const { refresh, me } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<CoreApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (me) {
      router.replace("/");
    }
  }, [me, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "login failed", 500));
    } finally {
      setSubmitting(false);
    }
  }

  if (me) {
    return (
      <p className="p-8 text-sm text-muted" role="status">
        Already signed in. Returning to Home…
      </p>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-md border border-line bg-surface p-8">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted">VerityOS</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-muted">Use your organization credentials. Session cookies stay on this host.</p>
        <form className="mt-6 space-y-4" onSubmit={(event) => void onSubmit(event)}>
          <label className="field">
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
          <button className="btn btn-primary w-full" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
