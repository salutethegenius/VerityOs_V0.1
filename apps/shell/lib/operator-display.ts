import type { Citation } from "./api/types";

export type DisplayCitation = {
  key: string;
  title: string;
  chunkCount: number;
  source_id?: string;
  source_version_id?: string;
  page?: string | number;
};

export function dedupeCitations(citations: Citation[] | null | undefined): DisplayCitation[] {
  const groups = new Map<string, DisplayCitation>();
  for (const citation of citations ?? []) {
    const title = citation.title?.trim() || "Untitled source";
    const key = citation.source_version_id || citation.source_id || title;
    const existing = groups.get(key);
    const add = typeof citation.chunk_count === "number" && citation.chunk_count > 0 ? citation.chunk_count : 1;
    if (existing) {
      existing.chunkCount += add;
      continue;
    }
    groups.set(key, {
      key,
      title,
      chunkCount: add,
      source_id: citation.source_id,
      source_version_id: citation.source_version_id,
      page: citation.page,
    });
  }
  return [...groups.values()];
}

const MOCK_PREFIX = /^mock:[^:\n]+:/;

export function presentMockArtifact(text: string | null | undefined): {
  mock: boolean;
  recorded: string;
} {
  const recorded = text ?? "";
  return { mock: MOCK_PREFIX.test(recorded), recorded };
}

export function skillLabel(skillId: string | null | undefined): string {
  if (!skillId) return "—";
  const labels: Record<string, string> = {
    "nova.research": "Research",
    "nova.drafting": "Drafting",
    "nova.social.draft": "Social Draft",
  };
  return labels[skillId] ?? skillId.replace(/[._]/g, " ");
}

export function executionStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const labels: Record<string, string> = {
    created: "Opened",
    running: "In progress",
    waiting_approval: "Awaiting approval",
    completed: "Completed",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

export function approvalFilterLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    denied: "Rejected",
  };
  return labels[status] ?? status;
}

export function actorDisplay(input: {
  name?: string | null;
  email?: string | null;
  id?: string | null;
}): string {
  if (input.name && input.email) return `${input.name} (${input.email})`;
  if (input.name) return input.name;
  if (input.email) return input.email;
  return input.id ?? "—";
}
