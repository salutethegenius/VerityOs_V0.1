import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-sm border border-line bg-surface p-4 shadow-panel ${className}`}>
      {children}
    </section>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <p className="border border-dashed border-line bg-surface px-4 py-8 text-sm text-muted" role="status">
      {label}…
    </p>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-dashed border-line bg-surface px-4 py-8">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}

export function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-danger/30 bg-surface px-4 py-4 text-sm" role="alert">
      <p className="font-medium text-danger">{message}</p>
      {requestId ? <p className="mt-1 font-mono text-xs text-muted">request_id {requestId}</p> : null}
      {onRetry ? (
        <button type="button" className="btn mt-3" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
}) {
  const tones = {
    neutral: "border-line text-muted",
    ok: "border-ok/30 text-ok",
    warn: "border-warn/40 text-warn",
    danger: "border-danger/30 text-danger",
    accent: "border-accent/30 text-accent",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${tones[tone]}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
