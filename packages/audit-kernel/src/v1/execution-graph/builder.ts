/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 */
import { randomUUID } from "crypto";
import { hashContent } from "../ledger/hash.js";
import type {
  ExecutionGraphPayload,
  ExecutionGraphRequest,
  ExecutionGraphModelSelection,
  ExecutionGraphModelExecution,
  ExecutionGraphValidation,
  ExecutionGraphRelease,
  ValidationFailure,
} from "./types.js";

export interface BuildGraphInput {
  requestInputHash: string;
  riskClassification: "low" | "medium" | "high";
  selectedModel: string;
  policyVersion: string;
  promptHash: string;
  rawOutputHash: string;
  latencyMs: number;
  validationFailures?: ValidationFailure[];
  fallbackTriggered?: boolean;
  rulesApplied?: string[];
}

export function buildExecutionGraph(input: BuildGraphInput): {
  graphId: string;
  payload: ExecutionGraphPayload;
  executionGraphHash: string;
} {
  const graphId = randomUUID();
  const receivedAt = new Date().toISOString();
  const releasedAt = new Date().toISOString();

  const request: ExecutionGraphRequest = {
    inputHash: input.requestInputHash,
    receivedAt,
    riskClassification: input.riskClassification,
  };

  const modelSelection: ExecutionGraphModelSelection = {
    policyVersion: input.policyVersion,
    selectedModel: input.selectedModel,
    reason: "risk-tier match",
  };

  const modelExecution: ExecutionGraphModelExecution = {
    promptHash: input.promptHash,
    rawOutputHash: input.rawOutputHash,
    latencyMs: input.latencyMs,
  };

  const validation: ExecutionGraphValidation = {
    rulesApplied: input.rulesApplied ?? [],
    failuresDetected: input.validationFailures ?? [],
    fallbackTriggered: input.fallbackTriggered ?? false,
  };

  const release: ExecutionGraphRelease = {
    released: true,
    releasedAt,
  };

  const payload: ExecutionGraphPayload = {
    graphId,
    request,
    modelSelection,
    modelExecution,
    validation,
    release,
  };

  const canonicalJson = canonicalize(payload);
  const executionGraphHash = hashContent(canonicalJson);

  return { graphId, payload, executionGraphHash };
}

function canonicalize(obj: ExecutionGraphPayload): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys) as T;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as object).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted as T;
}
