"use client";

import { useState } from "react";
import { shortHash } from "@/lib/format";

export function HashValue({ value, label }: { value: string | null | undefined; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!value) return <span>—</span>;
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs">
      <span title={value}>{open ? value : shortHash(value)}</span>
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Reveal"}
      </button>
      <button
        type="button"
        className="link-btn"
        onClick={() => navigator.clipboard.writeText(value)}
        aria-label={label ? `Copy ${label}` : "Copy hash"}
      >
        Copy
      </button>
    </span>
  );
}
