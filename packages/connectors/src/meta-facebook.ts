import { requestHash, sha256Hex } from "./hash.js";
import {
  ConnectorError,
  type Connector,
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorHealth,
} from "./types.js";

const GRAPH_BASE = process.env.META_GRAPH_BASE ?? "https://graph.facebook.com";
const DEFAULT_VERSION = "v23.0";
const MIN_SCHEDULE_OFFSET_SEC = 10 * 60;
const MAX_SCHEDULE_OFFSET_SEC = 30 * 24 * 60 * 60;

export interface MetaFacebookOptions {
  fetchImpl?: typeof fetch;
  apiVersion?: string;
  timeoutMs?: number;
}

function httpClass(status: number): string {
  if (status >= 500) {
    return "5xx";
  }
  if (status >= 400) {
    return "4xx";
  }
  if (status >= 200) {
    return "2xx";
  }
  return "other";
}

function parseScheduleUnix(iso: string, nowSec = Math.floor(Date.now() / 1000)): number {
  let normalized = iso.trim();
  if (normalized.endsWith("Z")) {
    normalized = `${normalized.slice(0, -1)}+00:00`;
  }
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) {
    throw new ConnectorError("INVALID_SCHEDULE", "scheduled_for is not a valid timestamp");
  }
  const unix = Math.floor(dt.getTime() / 1000);
  if (unix < nowSec + MIN_SCHEDULE_OFFSET_SEC) {
    throw new ConnectorError("INVALID_SCHEDULE", "schedule time must be at least 10 minutes in the future");
  }
  if (unix > nowSec + MAX_SCHEDULE_OFFSET_SEC) {
    throw new ConnectorError("INVALID_SCHEDULE", "schedule time must be within 30 days");
  }
  return unix;
}

function safeMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const blocked = /token|secret|password|authorization/i;
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (blocked.test(key)) {
      continue;
    }
    if (typeof value === "string" && blocked.test(value) && value.length > 20) {
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}

export class MetaFacebookConnector implements Connector {
  readonly id = "meta.facebook";
  readonly type = "meta.facebook";
  readonly version = "1.0.0";
  readonly capabilities = ["publish_post", "schedule_post", "health"];
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(options: MetaFacebookOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? process.env.META_API_VERSION ?? DEFAULT_VERSION;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private endpoint(pageId: string, edge = ""): string {
    const suffix = edge ? `/${edge.replace(/^\//, "")}` : "";
    return `${GRAPH_BASE}/${this.apiVersion}/${pageId}${suffix}`;
  }

  private async call(
    url: string,
    init: RequestInit,
    label: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw new ConnectorError(
          "AMBIGUOUS_PROVIDER_OUTCOME",
          `${label}: non-JSON response`,
          httpClass(response.status),
          true
        );
      }
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new ConnectorError(
          "AMBIGUOUS_PROVIDER_OUTCOME",
          `${label}: provider status ${response.status}`,
          httpClass(response.status),
          true
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ConnectorError("PROVIDER_AUTH_FAILED", `${label}: authentication failed`, httpClass(response.status));
      }
      if (!response.ok || body.error) {
        throw new ConnectorError("PROVIDER_REJECTED", `${label}: provider rejected the request`, httpClass(response.status));
      }
      return { status: response.status, body };
    } catch (err) {
      if (err instanceof ConnectorError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new ConnectorError("AMBIGUOUS_PROVIDER_OUTCOME", `${label}: timeout`, "timeout", true);
      }
      throw new ConnectorError("AMBIGUOUS_PROVIDER_OUTCOME", `${label}: transport error`, "timeout", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(input: { connectorId: string; pageId: string; secret: string }): Promise<ConnectorHealth> {
    const url = `${this.endpoint(input.pageId)}?fields=name&access_token=${encodeURIComponent(input.secret)}`;
    try {
      const { body } = await this.call(url, { method: "GET" }, "Meta health");
      const pageName = typeof body.name === "string" ? body.name : undefined;
      return {
        ok: Boolean(pageName),
        connector_id: input.connectorId,
        connector_type: this.type,
        page_name: pageName,
      };
    } catch (err) {
      const code = err instanceof ConnectorError ? err.code : "PROVIDER_REJECTED";
      return {
        ok: false,
        connector_id: input.connectorId,
        connector_type: this.type,
        reason_code: code,
      };
    }
  }

  async execute(input: ConnectorActionInput): Promise<ConnectorActionResult> {
    const message = String(input.payload.message ?? "");
    const occurredAt = new Date().toISOString();
    const requestPayload = {
      action: input.action,
      artifact_hash: input.artifactHash,
      message,
      page_id: input.pageId,
      scheduled_for: input.scheduledFor ?? null,
    };
    const hashed = requestHash(requestPayload);
    if (input.action === "publish_post") {
      const { status, body } = await this.call(
        this.endpoint(input.pageId, "feed"),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            message,
            access_token: input.secret,
          }).toString(),
        },
        "Meta publish"
      );
      const externalId = String(body.post_id ?? body.id ?? "");
      if (!externalId) {
        throw new ConnectorError("AMBIGUOUS_PROVIDER_OUTCOME", "Meta publish returned no id", httpClass(status), true);
      }
      return {
        connector_id: input.connectorId,
        connector_type: this.type,
        action: input.action,
        external_action_id: externalId,
        status: "ok",
        occurred_at: occurredAt,
        request_hash: hashed,
        response_hash: sha256Hex(JSON.stringify({ id: externalId })),
        metadata: safeMetadata({ http_class: httpClass(status) }),
      };
    }
    if (input.action === "schedule_post") {
      if (!input.scheduledFor) {
        throw new ConnectorError("INVALID_SCHEDULE", "scheduled_for is required");
      }
      const unix = parseScheduleUnix(input.scheduledFor);
      const { status, body } = await this.call(
        this.endpoint(input.pageId, "feed"),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            message,
            published: "false",
            scheduled_publish_time: String(unix),
            unpublished_content_type: "SCHEDULED",
            access_token: input.secret,
          }).toString(),
        },
        "Meta schedule"
      );
      const externalId = String(body.post_id ?? body.id ?? "");
      if (!externalId) {
        throw new ConnectorError("AMBIGUOUS_PROVIDER_OUTCOME", "Meta schedule returned no id", httpClass(status), true);
      }
      return {
        connector_id: input.connectorId,
        connector_type: this.type,
        action: input.action,
        external_action_id: externalId,
        status: "ok",
        occurred_at: occurredAt,
        request_hash: hashed,
        response_hash: sha256Hex(JSON.stringify({ id: externalId })),
        metadata: safeMetadata({ http_class: httpClass(status), scheduled_for: input.scheduledFor }),
      };
    }
    throw new ConnectorError("UNKNOWN_ACTION", `unsupported Meta action ${input.action}`);
  }
}
