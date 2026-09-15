import { api } from "./client";
import type { SessionProfile } from "./types";

export function login(email: string, password: string) {
  return api<{ user_id: string; organization_id: string; role: string; permissions: string[] }>(
    "/v1/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) }
  );
}

export function logout() {
  return api<{ ok: boolean }>("/v1/auth/logout", { method: "POST", body: JSON.stringify({}) });
}

export function getMe() {
  return api<SessionProfile>("/v1/me");
}

export function getHomeSummary() {
  return api<import("./types").HomeSummary>("/v1/home/summary");
}
