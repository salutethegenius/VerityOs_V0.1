export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function publicMessage(err: unknown): { statusCode: number; code: string; message: string } {
  if (err instanceof ApiError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err && typeof err === "object" && "statusCode" in err && "code" in err) {
    const e = err as { statusCode: number; code: string; message?: string };
    return {
      statusCode: e.statusCode,
      code: String(e.code),
      message: e.message ?? "request failed",
    };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "internal error" };
}
