import type { ExecutionGraphV2, ExecutionStatus } from "@verityos/contracts";
import { EXECUTION_GRAPH_SCHEMA_VERSION } from "@verityos/contracts";
import { canonicalize } from "../hashing/canonicalize.js";
import { sha256Hex } from "../hashing/hash.js";
import type { ExecutionRow } from "../types.js";
import type { ExecutionEventRow } from "./events.js";

export const GRAPH_SCHEMA_VERSION = EXECUTION_GRAPH_SCHEMA_VERSION;

export class UnresolvedGraphParentError extends Error {
  readonly code = "GRAPH_PARENT_UNRESOLVED";
  readonly parentEventIds: string[];
  constructor(parentEventIds: string[]) {
    super("Execution Graph V2 contains unresolved parent_event_ids");
    this.name = "UnresolvedGraphParentError";
    this.parentEventIds = [...new Set(parentEventIds)];
  }
}

export function buildExecutionGraphV2(
  execution: Pick<ExecutionRow, "id" | "verity_record_id" | "organization_id" | "status">,
  events: ExecutionEventRow[]
): ExecutionGraphV2 {
  const ordered = [...events].sort((a, b) => a.event_sequence - b.event_sequence);
  const nodes = ordered.map((event) => ({
    event_id: event.id,
    sequence: event.event_sequence,
    event_type: event.event_type,
    status: event.status,
    occurred_at_canonical: event.occurred_at_canonical,
    input_hash: event.input_hash,
    output_hash: event.output_hash,
    metadata: sortMetadata(event.metadata ?? {}),
  }));
  const byId = new Map(ordered.map((event) => [event.id, event]));
  const unresolved = ordered.flatMap((event) =>
    event.parent_event_ids.filter((parentId) => !byId.has(parentId))
  );
  if (unresolved.length > 0) {
    throw new UnresolvedGraphParentError(unresolved);
  }
  const edges = ordered.flatMap((event) =>
    [...event.parent_event_ids]
      .sort()
      .map((parentId) => ({
        from_event_id: parentId,
        to_event_id: event.id,
      }))
  );
  edges.sort((a, b) => {
    const from = a.from_event_id < b.from_event_id ? -1 : a.from_event_id > b.from_event_id ? 1 : 0;
    if (from !== 0) {
      return from;
    }
    return a.to_event_id < b.to_event_id ? -1 : a.to_event_id > b.to_event_id ? 1 : 0;
  });
  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    execution_id: execution.id,
    verity_record_id: execution.verity_record_id,
    organization_id: execution.organization_id,
    status: execution.status as ExecutionStatus,
    nodes,
    edges,
  };
}

export function computeExecutionGraphHash(graph: ExecutionGraphV2): string {
  return sha256Hex(
    canonicalize({
      execution_graph_schema_version: GRAPH_SCHEMA_VERSION,
      graph,
    })
  );
}

function sortMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(metadata).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = metadata[key];
  }
  return out;
}
