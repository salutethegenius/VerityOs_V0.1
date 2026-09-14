/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 */
export interface ExecutionGraphRequest {
  inputHash: string;
  receivedAt: string;
  riskClassification: "low" | "medium" | "high";
}

export interface ExecutionGraphModelSelection {
  policyVersion: string;
  selectedModel: string;
  reason: string;
}

export interface ExecutionGraphModelExecution {
  promptHash: string;
  rawOutputHash: string;
  latencyMs: number;
}

export interface ValidationFailure {
  type: string;
  description: string;
  actionTaken: string;
}

export interface ExecutionGraphValidation {
  rulesApplied: string[];
  failuresDetected: ValidationFailure[];
  fallbackTriggered: boolean;
}

export interface ExecutionGraphRelease {
  released: boolean;
  releasedAt: string;
}

export interface ExecutionGraphPayload {
  graphId: string;
  request: ExecutionGraphRequest;
  modelSelection: ExecutionGraphModelSelection;
  modelExecution: ExecutionGraphModelExecution;
  validation: ExecutionGraphValidation;
  release: ExecutionGraphRelease;
}
