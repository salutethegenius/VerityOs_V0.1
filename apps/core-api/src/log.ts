const SECRET_KEYS = /password|secret|token|authorization|cookie|api[_-]?key|database_url/i;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 24 && SECRET_KEYS.test(value)) {
      return "[redacted]";
    }
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(item);
    }
    return out;
  }
  return value;
}

export function logEvent(event: Record<string, unknown>): void {
  const redacted = redact(event) as Record<string, unknown>;
  const line = {
    ts: new Date().toISOString(),
    service: "core-api",
    ...redacted,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
