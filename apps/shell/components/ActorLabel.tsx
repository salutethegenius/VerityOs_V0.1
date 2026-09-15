"use client";

import { HashValue } from "@/components/HashValue";
import { actorDisplay } from "@/lib/operator-display";

export function ActorLabel({
  name,
  email,
  id,
}: {
  name?: string | null;
  email?: string | null;
  id?: string | null;
}) {
  const label = actorDisplay({ name, email, id });
  return (
    <span className="inline-flex flex-col gap-1">
      <span>{label}</span>
      {id ? <HashValue value={id} label="actor id" /> : null}
    </span>
  );
}
