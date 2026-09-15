export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    request_id?: string;
  };
};

export class CoreApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = "CoreApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function parseApiError(payload: unknown, status: number, requestId?: string): CoreApiError {
  const body = payload as ApiErrorBody | undefined;
  const error = body?.error;
  return new CoreApiError(
    error?.code ?? "REQUEST_FAILED",
    error?.message ?? "request failed",
    status,
    error?.request_id ?? requestId
  );
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { error: { code: "INVALID_JSON", message: text.slice(0, 200), request_id: requestId } };
    }
  }
  if (!response.ok) {
    throw parseApiError(payload, response.status, requestId);
  }
  return payload as T;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof CoreApiError && error.status === 401;
}
