import { api } from "./client";
import type { SystemStatus } from "./types";

export function getSystemStatus() {
  return api<SystemStatus>("/v1/system/status");
}
