export type RiskTier = "low" | "medium" | "high";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type LedgerEntryType =
  | "request_opened"
  | "approval_requested"
  | "action_completed"
  | "final"
  | "failure";

export type ExecutionStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}
