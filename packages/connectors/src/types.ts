export type ConnectorType =
  | "meta.facebook"
  | "slack"
  | "email"
  | "sms"
  | "government_web"
  | "database"
  | "payments";

export type ConnectorActionStatus = "ok" | "failed" | "needs_review";

export interface ConnectorHealth {
  ok: boolean;
  connector_id: string;
  connector_type: string;
  page_name?: string;
  reason_code?: string;
}

export interface ConnectorActionInput {
  connectorId: string;
  connectorType: string;
  action: string;
  artifactHash: string;
  payload: Record<string, unknown>;
  secret: string;
  pageId: string;
  scheduledFor?: string | null;
}

export interface ConnectorActionResult {
  connector_id: string;
  connector_type: string;
  action: string;
  external_action_id: string | null;
  status: ConnectorActionStatus;
  occurred_at: string;
  request_hash: string;
  response_hash: string | null;
  metadata: Record<string, unknown>;
}

export interface Connector {
  id: string;
  type: ConnectorType | string;
  version: string;
  capabilities: string[];
  health(input: {
    connectorId: string;
    pageId: string;
    secret: string;
  }): Promise<ConnectorHealth>;
  execute(input: ConnectorActionInput): Promise<ConnectorActionResult>;
}

export class ConnectorError extends Error {
  readonly code: string;
  readonly httpClass: string | null;
  readonly ambiguous: boolean;
  constructor(code: string, message: string, httpClass: string | null = null, ambiguous = false) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.httpClass = httpClass;
    this.ambiguous = ambiguous;
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    this.connectors.set(connector.type, connector);
  }

  resolve(connectorType: string): Connector {
    const found = this.connectors.get(connectorType);
    if (!found) {
      throw new ConnectorError("CONNECTOR_TYPE_UNKNOWN", `no implementation for ${connectorType}`);
    }
    return found;
  }

  listTypes(): string[] {
    return [...this.connectors.keys()].sort();
  }
}

export type SecretResolver = (secretRef: string) => string | undefined;

export function envSecretResolver(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): SecretResolver {
  return (secretRef: string) => {
    const value = source[secretRef];
    return value && value.trim() ? value : undefined;
  };
}
