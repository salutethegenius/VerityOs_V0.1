import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { evaluatePolicy } from "@verityos/command";
import {
  CLASSIFICATION_RANK,
  RISK_RANK,
  type DataClassification,
  type DeploymentType,
  type ModelProvider,
  type ModelRouteRequest,
  type ModelRouteResult,
  type RiskTier,
} from "@verityos/contracts";

export interface ModelRow {
  id: string;
  organization_id: string;
  model_key: string;
  provider: ModelProvider;
  deployment_type: DeploymentType;
  endpoint: string | null;
  capabilities_json: string[];
  allowed_data_classes_json: DataClassification[];
  risk_ceiling: RiskTier;
  requires_internet: boolean;
  enabled: boolean;
}

const DEPLOY_RANK: Record<DeploymentType, number> = {
  local: 0,
  private: 1,
  cloud: 2,
};

export async function getModel(
  pool: Pool,
  organizationId: string,
  modelId: string
): Promise<ModelRow | null> {
  const models = await listModels(pool, organizationId);
  return models.find((m) => m.id === modelId) ?? null;
}

export async function listModels(pool: Pool, organizationId: string): Promise<ModelRow[]> {
  const result = await pool.query<ModelRow>(
    `SELECT id, organization_id, model_key, provider, deployment_type, endpoint,
            capabilities_json, allowed_data_classes_json, risk_ceiling,
            requires_internet, enabled
     FROM command.models
     WHERE organization_id = $1
     ORDER BY model_key`,
    [organizationId]
  );
  return result.rows;
}

export async function registerModel(
  pool: Pool,
  input: Omit<ModelRow, "id"> & { id?: string }
): Promise<string> {
  const id = input.id ?? randomUUID();
  await pool.query(
    `INSERT INTO command.models (
       id, organization_id, model_key, provider, deployment_type, endpoint,
       capabilities_json, allowed_data_classes_json, risk_ceiling, requires_internet, enabled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [
      id,
      input.organization_id,
      input.model_key,
      input.provider,
      input.deployment_type,
      input.endpoint,
      JSON.stringify(input.capabilities_json),
      JSON.stringify(input.allowed_data_classes_json),
      input.risk_ceiling,
      input.requires_internet,
      input.enabled,
    ]
  );
  return id;
}

export async function routeModel(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    roleId: string;
    request: ModelRouteRequest;
  }
): Promise<ModelRouteResult> {
  const policy = await evaluatePolicy(pool, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    roleId: input.roleId,
    action: {
      type: "skill.use",
      skillId: "models.route",
      classification: input.request.data_classification,
      riskTier: input.request.risk_tier,
    },
  });
  const none: ModelRouteResult = {
    model_id: null,
    provider: null,
    deployment_type: null,
    policy_version: policy.policy_version,
    selection_reason_code: "NO_ALLOWED_MODEL",
  };
  if (policy.decision === "deny") {
    return { ...none, selection_reason_code: policy.reason_code };
  }

  const models = (await listModels(pool, input.organizationId)).filter((m) => m.enabled);
  const leave = await evaluatePolicy(pool, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    roleId: input.roleId,
    action: { type: "data.leave_device", classification: input.request.data_classification },
  });
  const localRequired =
    leave.decision === "deny" ||
    CLASSIFICATION_RANK[input.request.data_classification] >= CLASSIFICATION_RANK.confidential;

  const eligible: ModelRow[] = [];
  for (const model of models) {
    if (
      !model.allowed_data_classes_json.includes(input.request.data_classification)
    ) {
      continue;
    }
    if (RISK_RANK[input.request.risk_tier] > RISK_RANK[model.risk_ceiling]) {
      continue;
    }
    const caps = new Set(model.capabilities_json);
    if (input.request.required_capabilities.some((c) => !caps.has(c))) {
      continue;
    }
    if (localRequired && model.deployment_type !== "local") {
      continue;
    }
    if (model.deployment_type === "cloud") {
      const cloud = await evaluatePolicy(pool, {
        organizationId: input.organizationId,
        actorId: input.actorId,
        roleId: input.roleId,
        action: {
          type: "model.process",
          classification: input.request.data_classification,
          deploymentType: "cloud",
          modelRiskCeiling: model.risk_ceiling,
          requestedRisk: input.request.risk_tier,
        },
      });
      if (cloud.decision === "deny") {
        continue;
      }
    }
    eligible.push(model);
  }

  eligible.sort((a, b) => {
    const deploy = DEPLOY_RANK[a.deployment_type] - DEPLOY_RANK[b.deployment_type];
    if (deploy !== 0) {
      return deploy;
    }
    return a.model_key.localeCompare(b.model_key);
  });

  if (eligible.length === 0) {
    const riskBlocked = models.some(
      (m) => RISK_RANK[input.request.risk_tier] > RISK_RANK[m.risk_ceiling]
    );
    if (riskBlocked && models.length > 0) {
      return { ...none, selection_reason_code: "MODEL_RISK_CEILING_EXCEEDED" };
    }
    return none;
  }

  let chosen = eligible[0];
  let reason = "MODEL_CAPABILITY_MATCH";
  if (localRequired) {
    chosen = eligible.find((m) => m.deployment_type === "local") ?? chosen;
    reason = "LOCAL_REQUIRED_CLASSIFICATION";
  } else if (input.request.prefer_local && eligible.some((m) => m.deployment_type === "local")) {
    chosen = eligible.find((m) => m.deployment_type === "local") ?? chosen;
    reason = "LOCAL_PREFERRED_AVAILABLE";
  } else if (chosen.deployment_type === "private") {
    reason = "PRIVATE_REQUIRED_POLICY";
  } else if (chosen.deployment_type === "cloud") {
    reason = "CLOUD_ALLOWED_FALLBACK";
  }

  return {
    model_id: chosen.id,
    provider: chosen.provider,
    deployment_type: chosen.deployment_type,
    policy_version: policy.policy_version,
    selection_reason_code: reason,
  };
}

export interface CompletionRequest {
  model: ModelRow;
  prompt: string;
  executionId: string;
}

export interface CompletionResult {
  text: string;
  provider: ModelProvider;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ModelAdapter {
  provider: ModelProvider;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class MockAdapter implements ModelAdapter {
  readonly provider = "mock" as const;
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = `mock:${request.model.model_key}:${request.prompt.slice(0, 80)}`;
    return {
      text,
      provider: "mock",
      usage: { input_tokens: request.prompt.length, output_tokens: text.length },
    };
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`provider_error:${response.status}`);
  }
  return response.json();
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider = "openai" as const;
  constructor(private readonly apiKey: string) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const json = (await postJson(
      request.model.endpoint ?? "https://api.openai.com/v1/chat/completions",
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: request.model.model_key,
        messages: [{ role: "user", content: request.prompt }],
      }
    )) as { choices: Array<{ message: { content: string } }> };
    const text = json.choices[0]?.message.content ?? "";
    return { text, provider: "openai", usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic" as const;
  constructor(private readonly apiKey: string) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const json = (await postJson(
      request.model.endpoint ?? "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model: request.model.model_key,
        max_tokens: 256,
        messages: [{ role: "user", content: request.prompt }],
      }
    )) as { content: Array<{ text?: string }> };
    const text = json.content.map((c) => c.text ?? "").join("");
    return { text, provider: "anthropic", usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

/** OpenAI-compatible HTTP (llama.cpp, Ollama, vLLM, Hummingbird). Not a product dependency. */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider = "openai-compatible" as const;
  constructor(private readonly apiKey?: string) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!request.model.endpoint) {
      throw new Error("openai-compatible adapter requires endpoint");
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const json = (await postJson(request.model.endpoint, headers, {
      model: request.model.model_key,
      messages: [{ role: "user", content: request.prompt }],
    })) as { choices: Array<{ message?: { content?: string }; text?: string }> };
    const text = json.choices[0]?.message?.content ?? json.choices[0]?.text ?? "";
    return { text, provider: "openai-compatible", usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

export function adapterFor(
  provider: ModelProvider,
  secrets: { openai?: string; anthropic?: string; compatible?: string }
): ModelAdapter {
  switch (provider) {
    case "mock":
      return new MockAdapter();
    case "openai":
      if (!secrets.openai) {
        throw new Error("OPENAI_API_KEY is not configured");
      }
      return new OpenAIAdapter(secrets.openai);
    case "anthropic":
      if (!secrets.anthropic) {
        throw new Error("ANTHROPIC_API_KEY is not configured");
      }
      return new AnthropicAdapter(secrets.anthropic);
    case "openai-compatible":
      return new OpenAICompatibleAdapter(secrets.compatible);
    default: {
      const _never: never = provider;
      throw new Error(`unknown provider ${_never}`);
    }
  }
}
